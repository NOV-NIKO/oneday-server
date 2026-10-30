#!/bin/sh
# 托管平台构建脚本：把运行时需要的文件放进 dist/
set -e
mkdir -p dist
cp server.js package.json dist/
if [ -f server.config.json ]; then cp server.config.json dist/; fi