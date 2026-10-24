process.stderr.write("源码目录不能直接打包或发布；请使用 npm run package:pack 生成经过编译与检查的安装包。\n");
process.exitCode = 1;
