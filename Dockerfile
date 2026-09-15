FROM node:22-slim

# 时区可被环境变量覆盖
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    PORT=5111 \
    DATA_DIR=/data

WORKDIR /app

# 先装依赖，利用镜像层缓存
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷贝源码
COPY . .

# 数据卷：所有账本数据都在这里，备份=拷走这一个目录
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node

EXPOSE 5111

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5111)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "server.js"]
