import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ==================== 页面路由 ====================

app.get(['/', '/index.html', '/player.html'], (req, res) => {
  try {
    let filePath;

    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;

      default:
        // / 和 /index.html
        filePath = path.join(__dirname, 'index.html');
        break;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    res.send(content);
  } catch (error) {
    console.error('页面读取错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = fs.readFileSync(filePath, 'utf8');
    res.send(content);
  } catch (error) {
    console.error('搜索页面读取错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

// ==================== URL 安全验证 ====================

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];

    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (
      process.env.BLOCKED_HOSTS ||
      'localhost,127.0.0.1,0.0.0.0,::1'
    ).split(',');

    // 从环境变量获取阻止的 IP 前缀
    const blockedPrefixes = (
      process.env.BLOCKED_IP_PREFIXES ||
      '192.168.,10.,172.'
    ).split(',');

    if (!allowedProtocols.includes(parsed.protocol)) {
      return false;
    }

    if (blockedHostnames.includes(parsed.hostname)) {
      return false;
    }

    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ==================== 公共代理限流 ====================

// 同一 IP 每 60 秒最多 120 次 /proxy/ 请求
const proxyRateLimit = new Map();
const PROXY_RATE_WINDOW = 60 * 1000;
const PROXY_RATE_MAX = 120;

function checkProxyRateLimit(req) {
  const forwarded =
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    'unknown';

  const ip = String(forwarded).split(',')[0].trim();
  const now = Date.now();

  let record = proxyRateLimit.get(ip);

  if (!record || now - record.start >= PROXY_RATE_WINDOW) {
    record = {
      start: now,
      count: 0
    };
  }

  record.count++;
  proxyRateLimit.set(ip, record);

  // 定期清理过期 IP，避免 Map 无限增长
  if (proxyRateLimit.size > 10000) {
    for (const [key, value] of proxyRateLimit) {
      if (now - value.start >= PROXY_RATE_WINDOW) {
        proxyRateLimit.delete(key);
      }
    }
  }

  return record.count <= PROXY_RATE_MAX;
}

// ==================== 视频代理 ====================

app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    // 公共代理限流
    if (!checkProxyRateLimit(req)) {
      return res.status(429).json({
        success: false,
        error: '请求过于频繁，请稍后再试'
      });
    }

    const encodedUrl = req.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    // 安全验证
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的 URL');
    }

    log(`代理请求: ${targetUrl}`);

    // 添加请求超时和重试逻辑
    const maxRetries = config.maxRetries;
    let retries = 0;

    const makeRequest = async () => {
      try {
        return await axios({
          method: 'get',
          url: targetUrl,
          responseType: 'stream',
          timeout: config.timeout,
          headers: {
            'User-Agent': config.userAgent,

            ...(new URL(targetUrl).hostname.endsWith('doubanio.com')
              ? {
                  'Referer': 'https://movie.douban.com/',
                  'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
                }
              : {})
          }
        });
      } catch (error) {
        if (retries < maxRetries) {
          retries++;
          log(`重试请求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }

        throw error;
      }
    };

    const response = await makeRequest();

    // 转发响应头（过滤敏感头）
    const headers = { ...response.headers };

    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS ||
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');

    sensitiveHeaders.forEach(header => {
      delete headers[header];
    });

    res.set(headers);

    // 管道传输响应流
    response.data.pipe(res);

  } catch (error) {
    console.error('代理请求错误:', error.message);

    if (error.response) {
      res.status(error.response.status || 500);

      if (error.response.data && typeof error.response.data.pipe === 'function') {
        error.response.data.pipe(res);
      } else {
        res.send('请求失败');
      }
    } else {
      res.status(500).send(`请求失败: ${error.message}`);
    }
  }
});

// ==================== 静态文件 ====================

app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge
}));

// ==================== 全局错误处理 ====================

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

// ==================== 404 ====================

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// ==================== 启动服务器 ====================

app.listen(config.port, () => {
  console.log(`宁阳TV服务器运行在 http://localhost:${config.port}`);

  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', config);
  }
});
