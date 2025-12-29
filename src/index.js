// src/index.js

let DB_READY = false; // 标记数据库是否已初始化

// 初始化数据库（自动建表）
async function initializeDB(env) {
  if (DB_READY) return;

  if (!env.DB) {
    console.warn('D1 数据库未绑定，部分功能将不可用');
    return;
  }

  try {
    // 检查表是否存在
    const check = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='methods'"
    ).first();

    if (!check) {
      console.log('methods 表不存在，正在自动创建...');

      await env.DB.exec(`
        CREATE TABLE methods (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          code TEXT NOT NULL,
          tags TEXT DEFAULT '',
          verified INTEGER DEFAULT 0,
          hash TEXT UNIQUE,
          simhash TEXT,
          created_at INTEGER DEFAULT (strftime('%s','now'))
        );

        CREATE INDEX IF NOT EXISTS idx_tags ON methods(tags);
        CREATE INDEX IF NOT EXISTS idx_simhash ON methods(simhash);
        CREATE INDEX IF NOT EXISTS idx_created_at ON methods(created_at);
      `);

      console.log('methods 表及索引创建成功！');
    } else {
      console.log('methods 表已存在，跳过创建');
    }

    DB_READY = true;
  } catch (e) {
    console.error('数据库初始化失败:', e);
    throw e;
  }
}

// SimHash 简单实现（轻量纯 JS，不依赖外部库）
function simpleSimHash(text) {
  const features = text.toLowerCase().match(/\w+/g) || [];
  const hashBits = new Array(64).fill(0);

  for (const feature of features) {
    let hash = 0;
    for (let i = 0; i < feature.length; i++) {
      hash = (hash * 31 + feature.charCodeAt(i)) & 0xffffffff;
    }
    for (let i = 0; i < 64; i++) {
      if (hash & (1 << i)) {
        hashBits[i] += 1;
      } else {
        hashBits[i] -= 1;
      }
    }
  }

  let fingerprint = 0n;
  for (let i = 0; i < 64; i++) {
    if (hashBits[i] > 0) {
      fingerprint |= (1n << BigInt(i));
    }
  }
  return fingerprint.toString(16).padStart(16, '0');
}

// 汉明距离计算
function hammingDistance(a, b) {
  let xor = a ^ b;
  let count = 0;
  while (xor) {
    count += xor & 1n;
    xor >>= 1n;
  }
  return Number(count);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 每次请求都尝试初始化数据库（安全无副作用）
    await initializeDB(env);

    // Webhook
    if (path === '/api/webhook' && request.method === 'POST') {
      return await handleWebhook(request, env);
    }

    // API 路由
    if (path.startsWith('/api/')) {
      return await handleApi(request, env);
    }

    // 其他路径由 Pages 处理静态文件
    return env.ASSETS.fetch(request);
  }
};

// ==================== Webhook 处理 ====================
async function handleWebhook(request, env) {
  if (!env.DB) return new Response('DB not bound', { status: 500 });

  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== env.WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const update = await request.json().catch(() => ({}));
  const message = update.message || update.channel_post;
  if (!message) return new Response('OK');

  const text = message.text || message.caption || '';
  const entities = message.entities || message.caption_entities || [];

  let code = '';
  let codeOffset = 0;
  for (const entity of entities) {
    if (entity.type === 'pre' || entity.type === 'code') {
      codeOffset = entity.offset;
      code = text.substring(entity.offset, entity.offset + entity.length);
      break;
    }
  }
  if (!code) return new Response('No code found');

  let title = text.substring(0, codeOffset).trim();
  if (!title) title = '未命名方法';
  title = title.split('\n').pop().trim() || title;

  const tagMatches = text.match(/#\w+/g) || [];
  const tags = [...new Set(tagMatches.map(t => t.substring(1)))].join(',');

  // SHA256 去重
  const encoder = new TextEncoder();
  const data = encoder.encode(code);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // SimHash
  const simhashHex = simpleSimHash(code);

  // 插入（去重）
  try {
    await env.DB.prepare(`
      INSERT INTO methods (title, code, tags, hash, simhash)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO NOTHING
    `).bind(title, code, tags, hash, simhashHex).run();
  } catch (e) {
    console.error('插入失败:', e);
  }

  return new Response('OK');
}

// ==================== API 处理 ====================
async function handleApi(request, env) {
  if (!env.DB) return new Response('Database not available', { status: 500 });

  const url = new URL(request.url);
  const path = url.pathname;

  const isAdmin = () => {
    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/admin_key=([^;]+)/);
    return match && match[1] === env.ADMIN_KEY;
  };

  // 搜索方法
  if (path === '/api/methods' && request.method === 'GET') {
    let query = `SELECT id, title, code, tags, verified FROM methods WHERE 1=1`;
    const params = [];

    const q = url.searchParams.get('q');
    const tag = url.searchParams.get('tag');

    if (q) {
      query += ` AND title LIKE ?`;
      params.push(`%${q}%`);
    }
    if (tag) {
      query += ` AND tags LIKE ?`;
      params.push(`%${tag}%`);
    }

    query += ` ORDER BY created_at DESC LIMIT 100`;

    const { results } = await env.DB.prepare(query).bind(...params).all();
    return Response.json(results);
  }

  // 导出已验证方法
  if (path === '/api/export') {
    const { results } = await env.DB.prepare(
      `SELECT title, code, tags, verified FROM methods WHERE verified = 1 ORDER BY created_at DESC`
    ).all();

    return new Response(JSON.stringify(results, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="methods.json"'
      }
    });
  }

  // 相似方法查询
  if (path === '/api/similar' && request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) return Response.json([]);

    const row = await env.DB.prepare(`SELECT simhash FROM methods WHERE id = ?`).bind(id).first();
    if (!row) return Response.json([]);

    const target = BigInt('0x' + row.simhash);

    const { results } = await env.DB.prepare(`SELECT id, title, simhash FROM methods`).all();
    const similar = results
      .map(r => ({
        id: r.id,
        title: r.title,
        distance: hammingDistance(target, BigInt('0x' + r.simhash))
      }))
      .filter(r => r.distance <= 8 && r.id !== Number(id))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 10);

    return Response.json(similar);
  }

  // 管理员登录
  if (path === '/api/admin/login' && request.method === 'POST') {
    const { key } = await request.json();
    if (key === env.ADMIN_KEY) {
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          'Set-Cookie': `admin_key=${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`
        }
      });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // 管理员更新
  if (path === '/api/admin/update' && request.method === 'POST') {
    if (!await isAdmin()) return new Response('Unauthorized', { status: 401 });

    const { id, tags, verified } = await request.json();
    await env.DB.prepare(`
      UPDATE methods SET tags = ?, verified = ? WHERE id = ?
    `).bind(tags || '', verified ? 1 : 0, id).run();

    return Response.json({ success: true });
  }

  return new Response('Not Found', { status: 404 });
}