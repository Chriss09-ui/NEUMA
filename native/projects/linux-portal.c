// Uses GLib/GIO already supplied by the supported Ubuntu Desktop environment.
#include <gio/gio.h>
#include <glib-unix.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

typedef struct {
  GMainLoop *loop;
  GDBusConnection *connection;
  gchar *request;
  int result;
} Selection;

static void write_json_string(const gchar *text) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
    if (*p == '\\' || *p == '"') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
  }
  putchar('"');
}

static void response(GDBusConnection *connection, const gchar *sender, const gchar *path,
  const gchar *interface, const gchar *member, GVariant *parameters, gpointer data) {
  (void)connection; (void)sender; (void)interface; (void)member;
  Selection *selection = data;
  if (!selection->request || strcmp(path, selection->request)) return;
  guint32 code; GVariant *results;
  g_variant_get(parameters, "(u@a{sv})", &code, &results);
  if (code == 1) { puts("{\"cancelled\":true}"); selection->result = 0; }
  else if (code == 0) {
    gchar **uris = NULL;
    if (g_variant_lookup(results, "uris", "^as", &uris) && uris && uris[0] && !uris[1]) {
      gchar *host = NULL, *folder = g_filename_from_uri(uris[0], &host, NULL);
      if (folder && g_path_is_absolute(folder) && (!host || !*host || !strcmp(host, "localhost"))) {
        fputs("{\"cancelled\":false,\"path\":", stdout); write_json_string(folder); puts("}"); selection->result = 0;
      }
      g_free(folder); g_free(host);
    }
    g_strfreev(uris);
  }
  g_variant_unref(results); g_main_loop_quit(selection->loop);
}

static gboolean stop(gpointer data) {
  Selection *selection = data;
  if (selection->request) g_dbus_connection_call(selection->connection, "org.freedesktop.portal.Desktop", selection->request,
    "org.freedesktop.portal.Request", "Close", NULL, NULL, G_DBUS_CALL_FLAGS_NONE, 1000, NULL, NULL, NULL);
  g_main_loop_quit(selection->loop); return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
  if (argc != 2 || strcmp(argv[1], "pick-folder")) return 2;
  GDBusConnection *connection = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
  if (!connection) return 2;
  Selection selection = {g_main_loop_new(NULL, FALSE), connection, NULL, 2};
  guint subscription = g_dbus_connection_signal_subscribe(connection, "org.freedesktop.portal.Desktop",
    "org.freedesktop.portal.Request", "Response", NULL, NULL, G_DBUS_SIGNAL_FLAGS_NONE, response, &selection, NULL);
  gchar *token = g_uuid_string_random();
  for (gchar *p = token; *p; ++p) if (*p == '-') *p = '_';
  GVariantBuilder options; g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
  g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token));
  g_variant_builder_add(&options, "{sv}", "directory", g_variant_new_boolean(TRUE));
  g_variant_builder_add(&options, "{sv}", "multiple", g_variant_new_boolean(FALSE));
  g_variant_builder_add(&options, "{sv}", "modal", g_variant_new_boolean(TRUE));
  GVariant *reply = g_dbus_connection_call_sync(connection, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
    "org.freedesktop.portal.FileChooser", "OpenFile", g_variant_new("(ssa{sv})", "", "选择要添加到 NEUMA 的项目文件夹", &options),
    G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE, 10000, NULL, NULL);
  g_free(token);
  if (reply) {
    g_variant_get(reply, "(o)", &selection.request); g_variant_unref(reply);
    guint interrupt = g_unix_signal_add(SIGINT, stop, &selection), terminate = g_unix_signal_add(SIGTERM, stop, &selection);
    guint deadline = g_timeout_add_seconds(300, stop, &selection);
    g_main_loop_run(selection.loop);
    // Signal/timeout callbacks may have removed their source already.
    if (g_main_context_find_source_by_id(NULL, interrupt)) g_source_remove(interrupt);
    if (g_main_context_find_source_by_id(NULL, terminate)) g_source_remove(terminate);
    if (g_main_context_find_source_by_id(NULL, deadline)) g_source_remove(deadline);
  }
  g_dbus_connection_signal_unsubscribe(connection, subscription);
  g_free(selection.request); g_main_loop_unref(selection.loop); g_object_unref(connection);
  return selection.result;
}
