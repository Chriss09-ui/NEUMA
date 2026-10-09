#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* These structures and access bits are the Linux Landlock ABI 3 UAPI. Keeping
 * them here permits a static build without requiring recent distro headers. */
struct neuma_ruleset_attr { uint64_t handled_access_fs; };
struct neuma_path_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif
#ifndef __NR_close_range
#define __NR_close_range 436
#endif
#ifndef __NR_fchmodat2
#define __NR_fchmodat2 452
#endif
#define LL_CREATE_VERSION 1
#define LL_RULE_PATH_BENEATH 1
#define LL_EXEC (1ULL << 0)
#define LL_WRITE_FILE (1ULL << 1)
#define LL_READ_FILE (1ULL << 2)
#define LL_READ_DIR (1ULL << 3)
#define LL_REMOVE_DIR (1ULL << 4)
#define LL_REMOVE_FILE (1ULL << 5)
#define LL_MAKE_REG (1ULL << 8)
#define LL_MAKE_DIR (1ULL << 7)
#define LL_MAKE_SYM (1ULL << 12)
#define LL_REFER (1ULL << 13)
#define LL_TRUNCATE (1ULL << 14)
#define LL_HANDLED ((1ULL << 15) - 1)
#define LL_READ (LL_READ_FILE | LL_READ_DIR)
#define LL_WORK (LL_READ | LL_WRITE_FILE | LL_REMOVE_DIR | LL_REMOVE_FILE | LL_MAKE_REG | LL_MAKE_DIR | LL_MAKE_SYM | LL_REFER | LL_TRUNCATE)
#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))

static volatile sig_atomic_t cancelled = 0;
static void stop_requested(int signal_number) { (void)signal_number; cancelled = 1; }
static uint64_t now_ms(void) { struct timespec value; clock_gettime(CLOCK_MONOTONIC, &value); return (uint64_t)value.tv_sec * 1000 + (uint64_t)value.tv_nsec / 1000000; }

static int same_canonical_path(const char *path, int directory) {
  struct stat info;
  char *actual;
  int ok;
  if (!path || path[0] != '/' || lstat(path, &info) || S_ISLNK(info.st_mode) || (directory ? !S_ISDIR(info.st_mode) : !S_ISREG(info.st_mode))) return 0;
  actual = realpath(path, NULL);
  ok = actual && !strcmp(actual, path);
  free(actual);
  return ok;
}

static int landlock_allow(int ruleset, const char *path, uint64_t access, int optional) {
  struct stat info;
  struct neuma_path_attr rule;
  int fd = open(path, O_PATH | O_CLOEXEC);
  int result;
  if (fd < 0) return optional && errno == ENOENT ? 0 : -1;
  if (fstat(fd, &info)) { close(fd); return -1; }
  if (!S_ISDIR(info.st_mode)) access &= LL_READ_FILE | LL_WRITE_FILE | LL_EXEC | LL_TRUNCATE;
  rule.allowed_access = access;
  rule.parent_fd = fd;
  result = syscall(__NR_landlock_add_rule, ruleset, LL_RULE_PATH_BENEATH, &rule, 0);
  close(fd);
  return result;
}

static int restrict_files(const char *node, const char *code, const char *write_path, const char *read_path) {
  struct neuma_ruleset_attr attr = { LL_HANDLED };
  int abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LL_CREATE_VERSION);
  int ruleset;
  if (abi < 3) return -1;
  ruleset = syscall(__NR_landlock_create_ruleset, &attr, sizeof(attr), 0);
  if (ruleset < 0) return -1;
  if (landlock_allow(ruleset, node, LL_EXEC | LL_READ_FILE, 0)
      || landlock_allow(ruleset, code, LL_READ, 0)
      || landlock_allow(ruleset, write_path, LL_WORK, 0)
      || (read_path && landlock_allow(ruleset, read_path, LL_READ, 0))) { close(ruleset); return -1; }
  const char *libraries[] = { "/lib", "/lib64", "/usr/lib", "/etc/ld.so.cache", "/sys/devices/system/cpu" };
  for (size_t index = 0; index < ARRAY_SIZE(libraries); index++)
    if (landlock_allow(ruleset, libraries[index], LL_READ, 1)) { close(ruleset); return -1; }
  const char *loaders[] = { "/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1", "/lib/ld-musl-x86_64.so.1", "/lib/ld-musl-aarch64.so.1" };
  for (size_t index = 0; index < ARRAY_SIZE(loaders); index++)
    if (landlock_allow(ruleset, loaders[index], LL_EXEC | LL_READ_FILE, 1)) { close(ruleset); return -1; }
  if (landlock_allow(ruleset, "/dev/null", LL_READ_FILE | LL_WRITE_FILE, 0)
      || landlock_allow(ruleset, "/dev/urandom", LL_READ_FILE, 0)
      || landlock_allow(ruleset, "/dev/random", LL_READ_FILE, 0)) { close(ruleset); return -1; }
  int result = syscall(__NR_landlock_restrict_self, ruleset, 0);
  close(ruleset);
  return result;
}

/* Landlock ABI 3 does not mediate chmod/chown/xattrs/timestamps, inherited FDs,
 * ptrace or io_uring. The syscall policy closes those gaps. Node's worker
 * threads are allowed, but process-producing clone flags are not. */
static int restrict_syscalls(void) {
  struct sock_filter instructions[512];
  unsigned short count = 0;
#define ADD_STMT(code, value) do { instructions[count++] = (struct sock_filter)BPF_STMT((code), (value)); } while (0)
#define ADD_JUMP(code, value, yes, no) do { instructions[count++] = (struct sock_filter)BPF_JUMP((code), (value), (yes), (no)); } while (0)
#define DENY(number) do { ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1); ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM); } while (0)
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch));
#if defined(__x86_64__)
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0);
#elif defined(__aarch64__)
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0);
#else
#error "Only x64 and ARM64 are supported"
#endif
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#if defined(__x86_64__)
  ADD_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS);
#endif
  /* Unknown future syscalls are never implicitly granted to generated code. */
  ADD_JUMP(BPF_JMP | BPF_JGE | BPF_K, 473, 0, 1);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
#ifdef __NR_clone3
  /* Classic BPF cannot inspect clone3's pointed-to flags. ENOSYS permits the
   * libc thread creation fallback to checked clone, without permitting clone3. */
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS);
#endif
#ifdef __NR_prlimit64
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prlimit64, 0, 7);
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2]));
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[2]) + 4);
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
#endif
#ifdef __NR_clone
  const uint32_t required = CLONE_THREAD | CLONE_VM | CLONE_SIGHAND;
  const uint32_t allowed = required | CLONE_FS | CLONE_FILES | CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID | CLONE_CHILD_SETTID | CLONE_DETACHED;
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 12);
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + 4);
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  ADD_STMT(BPF_ALU | BPF_AND | BPF_K, required);
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, required, 1, 0);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  ADD_STMT(BPF_ALU | BPF_AND | BPF_K, ~allowed);
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
#endif
#ifdef __NR_ioctl
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_ioctl, 0, 7);
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1]));
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x541b /* FIONREAD */, 3, 0);
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x5421 /* FIONBIO */, 2, 0);
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x5401 /* TCGETS */, 1, 0);
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0x5413 /* TIOCGWINSZ */, 0, 1);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
#endif
#ifdef __NR_prctl
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_prctl, 0, 5);
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_NAME, 1, 0);
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_GET_NAME, 0, 1);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
#endif
#ifdef __NR_tgkill
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_tgkill, 0, 4);
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]));
  ADD_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)getpid(), 0, 1);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM);
#endif
  /* Branches above load syscall arguments; reload nr for the remaining list. */
  ADD_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr));
#ifdef __NR_fork
  DENY(__NR_fork);
#endif
#ifdef __NR_vfork
  DENY(__NR_vfork);
#endif
#ifdef __NR_socket
  DENY(__NR_socket); DENY(__NR_socketpair); DENY(__NR_connect); DENY(__NR_bind); DENY(__NR_listen);
  DENY(__NR_accept); DENY(__NR_accept4); DENY(__NR_sendto); DENY(__NR_sendmsg); DENY(__NR_recvfrom); DENY(__NR_recvmsg);
#endif
#ifdef __NR_socketcall
  DENY(__NR_socketcall);
#endif
#ifdef __NR_chmod
  DENY(__NR_chmod);
#endif
  DENY(__NR_fchmod); DENY(__NR_fchmodat);
#ifdef __NR_fchmodat2
  DENY(__NR_fchmodat2);
#endif
#ifdef __NR_chown
  DENY(__NR_chown); DENY(__NR_lchown);
#endif
  DENY(__NR_fchown); DENY(__NR_fchownat);
  DENY(__NR_setxattr); DENY(__NR_lsetxattr); DENY(__NR_fsetxattr);
  DENY(__NR_removexattr); DENY(__NR_lremovexattr); DENY(__NR_fremovexattr);
  /* New UAPI numbers are shared by certified x64 and ARM64 kernels, even if
   * the build host's older headers do not yet declare them. */
  DENY(463); /* setxattrat, Linux 6.13 */
  DENY(466); /* removexattrat, Linux 6.13 */
  DENY(469); /* file_setattr */
#ifdef __NR_utime
  DENY(__NR_utime);
#endif
#ifdef __NR_utimes
  DENY(__NR_utimes);
#endif
  DENY(__NR_utimensat);
#ifdef __NR_futimesat
  DENY(__NR_futimesat);
#endif
  DENY(__NR_ptrace); DENY(__NR_process_vm_readv); DENY(__NR_process_vm_writev);
#ifdef __NR_kcmp
  DENY(__NR_kcmp);
#endif
#ifdef __NR_pidfd_getfd
  DENY(__NR_pidfd_getfd); DENY(__NR_pidfd_open); DENY(__NR_pidfd_send_signal);
#endif
#ifdef __NR_io_uring_setup
  DENY(__NR_io_uring_setup); DENY(__NR_io_uring_enter); DENY(__NR_io_uring_register);
#endif
  DENY(__NR_mount); DENY(__NR_umount2); DENY(__NR_pivot_root); DENY(__NR_chroot); DENY(__NR_unshare); DENY(__NR_setns);
  DENY(428); DENY(429); DENY(430); DENY(431); DENY(432); DENY(433); DENY(442); /* New mount APIs. */
  DENY(467); DENY(472); /* open_tree_attr, fchroot */
  DENY(440); DENY(448); DENY(460); /* Other-process memory and LSM changes. */
  DENY(__NR_setsid); DENY(__NR_setpgid); DENY(__NR_kill); DENY(__NR_tkill); DENY(__NR_rt_sigqueueinfo); DENY(__NR_rt_tgsigqueueinfo);
  DENY(__NR_open_by_handle_at); DENY(__NR_name_to_handle_at); DENY(__NR_execveat);
  DENY(__NR_bpf); DENY(__NR_perf_event_open); DENY(__NR_userfaultfd); DENY(__NR_seccomp);
  DENY(__NR_memfd_create); DENY(__NR_fanotify_init); DENY(__NR_fanotify_mark);
#ifdef __NR_inotify_init
  DENY(__NR_inotify_init);
#endif
  DENY(__NR_inotify_init1); DENY(__NR_inotify_add_watch); DENY(__NR_inotify_rm_watch);
  DENY(__NR_shmget); DENY(__NR_shmat); DENY(__NR_shmctl); DENY(__NR_semget); DENY(__NR_semctl); DENY(__NR_msgget); DENY(__NR_msgsnd); DENY(__NR_msgrcv); DENY(__NR_msgctl);
#ifdef __NR_keyctl
  DENY(__NR_keyctl); DENY(__NR_add_key); DENY(__NR_request_key);
#endif
  DENY(__NR_reboot); DENY(__NR_swapoff); DENY(__NR_swapon); DENY(__NR_sethostname); DENY(__NR_setdomainname);
#ifdef __NR_setrlimit
  DENY(__NR_setrlimit);
#endif
  DENY(__NR_mlock); DENY(__NR_mlockall); DENY(__NR_mlock2); DENY(__NR_sync); DENY(__NR_syncfs);
  ADD_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW);
  struct sock_fprog program = { count, instructions };
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program);
#undef DENY
#undef ADD_JUMP
#undef ADD_STMT
}

static int write_all(int fd, const char *data, size_t size) {
  while (size) {
    ssize_t written = write(fd, data, size);
    if (written < 0) { if (errno == EINTR && !cancelled) continue; return -1; }
    if (!written) return -1;
    data += written; size -= (size_t)written;
  }
  return 0;
}

static _Noreturn void child_setup_failed(void) {
  const unsigned char failed = 1;
  for (;;) {
    ssize_t written = write(3, &failed, sizeof(failed));
    if (written == (ssize_t)sizeof(failed)) break;
    if (written < 0 && errno == EINTR) continue;
    // A broken notification pipe cannot turn a setup failure into success.
    break;
  }
  _exit(125);
}

static int publish_status(const char *path, const char *status, unsigned int exit_code, const char *reason) {
  char output[256];
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  int size = snprintf(output, sizeof(output), "{\"protocol\":1,\"status\":\"%s\",\"exitCode\":%u,\"cleanupComplete\":true%s%s%s}\n", status, exit_code,
    reason ? ",\"reason\":\"" : "", reason ? reason : "", reason ? "\"" : "");
  int result = size < 0 || (size_t)size >= sizeof(output) || write_all(fd, output, (size_t)size) || fsync(fd);
  close(fd);
  return result ? -1 : 0;
}

int main(int argc, char **argv) {
  const char *node = NULL, *code = NULL, *write_path = NULL, *read_path = NULL, *cwd = NULL, *status_path = NULL;
  unsigned long timeout = 0, max_output = 0;
  int command_index = 0;
  for (int index = 1; index < argc; index++) {
    if (!strcmp(argv[index], "--")) { command_index = index + 1; break; }
    if (index + 1 >= argc) return 125;
    const char *key = argv[index++], *value = argv[index];
    if (!strcmp(key, "--node")) node = value;
    else if (!strcmp(key, "--code")) code = value;
    else if (!strcmp(key, "--write")) write_path = value;
    else if (!strcmp(key, "--read")) read_path = value;
    else if (!strcmp(key, "--cwd")) cwd = value;
    else if (!strcmp(key, "--status")) status_path = value;
    else if (!strcmp(key, "--timeout") || !strcmp(key, "--max-output")) {
      char *end; errno = 0; unsigned long number = strtoul(value, &end, 10);
      if (errno || *end) return 125;
      if (!strcmp(key, "--timeout")) timeout = number; else max_output = number;
    } else return 125;
  }
  if (!command_index || command_index >= argc || !status_path || status_path[0] != '/' || !timeout || timeout > 120000 || !max_output || max_output > 1048576
      || !same_canonical_path(node, 0) || !same_canonical_path(code, 1) || !same_canonical_path(write_path, 1)
      || !same_canonical_path(cwd, 1) || (read_path && !same_canonical_path(read_path, 1))) return 125;
  int output[2], errors[2], setup[2];
  if (pipe2(output, O_CLOEXEC) || pipe2(errors, O_CLOEXEC) || pipe2(setup, O_CLOEXEC)) {
    publish_status(status_path, "error", 125, "isolation_setup_failed"); return 125;
  }
  struct sigaction action = { 0 }; action.sa_handler = stop_requested; sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL); signal(SIGPIPE, SIG_IGN);
  pid_t parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGTERM) || getppid() != parent) { publish_status(status_path, "error", 125, "isolation_setup_failed"); return 125; }
  pid_t child = fork();
  if (child < 0) { publish_status(status_path, "error", 125, "isolation_setup_failed"); return 125; }
  if (!child) {
    pid_t supervisor = getppid();
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    if (dup2(output[1], STDOUT_FILENO) < 0 || dup2(errors[1], STDERR_FILENO) < 0 || dup3(setup[1], 3, O_CLOEXEC) < 0) _exit(125);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != supervisor || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
        || syscall(__NR_close_range, 4U, ~0U, 0) || chdir(cwd)) child_setup_failed();
    struct rlimit core = { 0, 0 }, file = { 64 * 1024 * 1024, 64 * 1024 * 1024 }, cpu = { timeout / 1000 + 2, timeout / 1000 + 2 };
    /* RLIMIT_DATA also covers anonymous writable mappings on Linux >=4.7.
     * RLIMIT_AS would incorrectly cap V8's large PROT_NONE reservations. The
     * supported-system canary must prove this bound still permits Node startup. */
    struct rlimit memory = { 256 * 1024 * 1024, 256 * 1024 * 1024 };
    if (setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_FSIZE, &file) || setrlimit(RLIMIT_CPU, &cpu) || setrlimit(RLIMIT_DATA, &memory)
        || restrict_files(node, code, write_path, read_path) || restrict_syscalls()) child_setup_failed();
    char **command = calloc((size_t)(argc - command_index + 2), sizeof(char *));
    if (!command) child_setup_failed();
    command[0] = (char *)node;
    for (int index = command_index; index < argc; index++) command[index - command_index + 1] = argv[index];
    execv(node, command);
    child_setup_failed();
  }
  close(output[1]); close(errors[1]); close(setup[1]);
  fcntl(output[0], F_SETFL, O_NONBLOCK); fcntl(errors[0], F_SETFL, O_NONBLOCK); fcntl(setup[0], F_SETFL, O_NONBLOCK);
  struct pollfd streams[2] = { { output[0], POLLIN, 0 }, { errors[0], POLLIN, 0 } };
  uint64_t deadline = now_ms() + timeout;
  unsigned long total = 0;
  int child_status = 0, reaped = 0, setup_failed = 0;
  const char *reason = NULL;
  while (!reaped || streams[0].fd >= 0 || streams[1].fd >= 0) {
    if (!reason && (cancelled || now_ms() >= deadline)) { reason = cancelled ? "process_terminated" : "timeout"; kill(child, SIGKILL); }
    (void)poll(streams, ARRAY_SIZE(streams), 20);
    for (size_t index = 0; index < ARRAY_SIZE(streams); index++) {
      if (streams[index].fd < 0) continue;
      char data[4096]; ssize_t size;
      while ((size = read(streams[index].fd, data, sizeof(data))) > 0) {
        size_t permitted = total >= max_output ? 0 : (size_t)(max_output - total);
        if (permitted > (size_t)size) permitted = (size_t)size;
        if (permitted && write_all(index ? STDERR_FILENO : STDOUT_FILENO, data, permitted) && !reason) { reason = "process_terminated"; kill(child, SIGKILL); }
        total += permitted;
        if ((size_t)size > permitted && !reason) { reason = "output_limit"; kill(child, SIGKILL); }
      }
      if (!size || (size < 0 && errno != EAGAIN && errno != EINTR)) { close(streams[index].fd); streams[index].fd = -1; }
    }
    unsigned char failure;
    if (read(setup[0], &failure, 1) > 0) setup_failed = 1;
    if (!reaped) { pid_t waited = waitpid(child, &child_status, WNOHANG); if (waited == child) reaped = 1; else if (waited < 0 && errno != EINTR) { reaped = 1; reason = "process_terminated"; } }
  }
  close(setup[0]);
  unsigned int exit_code = WIFEXITED(child_status) ? (unsigned int)WEXITSTATUS(child_status) : WIFSIGNALED(child_status) ? 128U + (unsigned int)WTERMSIG(child_status) : 125U;
  if (setup_failed) reason = "isolation_setup_failed";
  else if (WIFSIGNALED(child_status) && !reason) reason = "process_terminated";
  const char *status = reason ? "error" : exit_code ? "failed" : "passed";
  if (publish_status(status_path, status, exit_code, reason)) return 125;
  return !strcmp(status, "passed") ? 0 : 1;
}
