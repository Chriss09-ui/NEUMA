const messages = {
  unsupported_managed_platform: "当前平台尚未验证新的托管运行方式，请使用已支持的平台。",
  docker_not_running: "Docker 尚未启动，请启动后重试。",
  docker_unavailable: "没有找到可用的 Docker，请先安装并启动。",
  docker_build_failed: "容器构建失败，已有代码保留，请查看本机运行记录。",
  python_download_failed: "Python 环境下载未完成，请检查网络后重试。",
  integrity_mismatch: "下载文件校验不一致，已停止安装，请重新准备环境。",
  data_changed_after_migration: "迁移后已有新的数据写入，不能直接覆盖为旧备份；当前数据已保留。",
  migration_source_changed: "迁移期间数据发生变化，已停止切换；请等待当前写入结束后重试。",
  data_migration_failed: "数据迁移程序未完成，正式数据未切换，备份已保留。",
  data_migration_verification_failed: "迁移后的数据未通过核验，正式数据未切换，备份已保留。",
  migration_contract_missing: "这个版本缺少对应的数据迁移方案，请先补充并验收。",
  migration_forward_copy_unavailable: "找不到可以核验的迁移后数据副本，请保留现有备份后检查。",
  gateway_port_busy: "原接口端口已被占用，请关闭占用程序后重试。",
  delivery_changed: "交付版本已变化，请刷新后重新选择操作。",
  invalid_gateway_actions: "请选择当前版本中允许对外调用的功能。",
  workflow_resolution_required: "请先核实上次操作是否已经发生，再决定补充结果或重试。",
};
export const serviceErrorMessage = (reason) => messages[reason] ?? "运行操作未完成，已有记录保留，请检查运行环境和交付版本后重试。";
