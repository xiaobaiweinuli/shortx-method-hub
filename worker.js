// Cloudflare Worker - ShortX Method Hub (完整增强版)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    const ADMIN_KEY = env.ADMIN_KEY || "admin123";
    const BOT_TOKEN = env.BOT_TOKEN;
    const WEBHOOK_SECRET = env.WEBHOOK_SECRET || "webhook_secret";
    const DB = env.SHORTX_DB;
    
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
        }
      });
    }
    
    // 首页
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(getHTMLPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    
    // 初始化数据库（增加 updated_at 字段）
    if (url.pathname === '/init-db') {
      if (!DB) return jsonResponse({ error: '未绑定 D1 数据库' }, 500);
      
      try {
        await DB.prepare(`
          CREATE TABLE IF NOT EXISTS methods (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            code TEXT NOT NULL,
            tags TEXT,
            verified INTEGER DEFAULT 0,
            author TEXT,
            source TEXT,
            chat_id TEXT,
            message_id INTEGER,
            link TEXT,
            hash TEXT UNIQUE,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            updated_at INTEGER
          )
        `).run();
        
        await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_hash ON methods(hash)`).run();
        await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_tags ON methods(tags)`).run();
        await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_verified ON methods(verified)`).run();
        await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_title ON methods(title)`).run();
        await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_code ON methods(code)`).run();
        await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_message ON methods(chat_id, message_id)`).run();
        
        try {
          await DB.prepare(`ALTER TABLE methods ADD COLUMN link TEXT`).run();
        } catch (e) {
          if (!e.message.includes('duplicate column name')) throw e;
        }
        
        try {
          await DB.prepare(`ALTER TABLE methods ADD COLUMN updated_at INTEGER`).run();
        } catch (e) {
          if (!e.message.includes('duplicate column name')) throw e;
        }
        
        await DB.prepare(`
          CREATE TABLE IF NOT EXISTS group_configs (
            chat_id TEXT PRIMARY KEY,
            chat_title TEXT,
            chat_type TEXT,
            enabled INTEGER DEFAULT 1,
            allowed_thread_ids TEXT DEFAULT '',
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
          )
        `).run();
        
        try {
          await DB.prepare(`ALTER TABLE group_configs ADD COLUMN chat_type TEXT`).run();
        } catch (e) {
          if (!e.message.includes('duplicate column name')) throw e;
        }
        
        await DB.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_id ON group_configs(chat_id)`).run();
        
        return jsonResponse({ success: true, message: '数据库初始化成功（包含更新时间字段）' });
      } catch (error) {
        return jsonResponse({ error: '数据库操作失败', detail: error.message }, 500);
      }
    }
    
    // Telegram Webhook（支持消息编辑 + 群组加入事件）
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (secret && secret !== WEBHOOK_SECRET) {
        return jsonResponse({ error: '无效的 webhook secret' }, 403);
      }
      
      try {
        const update = await request.json();
        
        // 处理 Bot 加入群组事件
        if (update.my_chat_member) {
          const member = update.my_chat_member;
          const chat = member.chat;
          const newStatus = member.new_chat_member.status;
          const oldStatus = member.old_chat_member.status;
          
          // Bot 被添加为管理员
          if (newStatus === 'administrator' && 
              (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
            const chatIdStr = chat.id.toString();
            
            const existing = await DB.prepare('SELECT chat_id FROM group_configs WHERE chat_id = ?')
              .bind(chatIdStr).first();
            
            if (!existing) {
              await DB.prepare(`
                INSERT INTO group_configs (chat_id, chat_title, enabled, allowed_thread_ids, chat_type)
                VALUES (?, ?, 1, '', ?)
              `).bind(chatIdStr, chat.title || '未知群组', chat.type).run();
            } else {
              // 更新群组信息
              await DB.prepare(`
                UPDATE group_configs 
                SET chat_title = ?, chat_type = ?, updated_at = strftime('%s', 'now')
                WHERE chat_id = ?
              `).bind(chat.title || '未知群组', chat.type, chatIdStr).run();
            }
          }
          
          // Bot 被移除或降级为普通成员
          if ((newStatus === 'left' || newStatus === 'kicked' || newStatus === 'member') && 
              (oldStatus === 'administrator')) {
            const chatIdStr = chat.id.toString();
            // 删除群组配置和相关方法
            await DB.prepare('DELETE FROM group_configs WHERE chat_id = ?').bind(chatIdStr).run();
            await DB.prepare('DELETE FROM methods WHERE chat_id = ?').bind(chatIdStr).run();
          }
          
          return new Response('OK', { status: 200 });
        }
        
        const msg = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
        if (!msg) return new Response('OK', { status: 200 });
        
        const isEdit = !!(update.edited_message || update.edited_channel_post);
        
        const messageText = msg.text || msg.caption || '';
        if (!messageText) return new Response('OK', { status: 200 });
        
        const messageId = msg.message_id;
        const chat = msg.chat;
        const fromUser = msg.from;
        const author = fromUser?.username || chat?.username || 'anonymous';
        
        const codeBlocks = extractCodeBlocksFromMessage(msg, messageText);
        
        if (codeBlocks.length === 0) return new Response('OK', { status: 200 });
        
        let shouldProcess = true;
        if (chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
          const chatIdStr = chat.id.toString();
          
          const config = await DB.prepare('SELECT enabled, allowed_thread_ids FROM group_configs WHERE chat_id = ?')
            .bind(chatIdStr).first();
          
          let enabled = true;
          let allowedThreadIds = [];
          
          if (config) {
            enabled = config.enabled === 1;
            if (config.allowed_thread_ids && config.allowed_thread_ids.trim() !== '') {
              allowedThreadIds = config.allowed_thread_ids.split(',')
                .map(id => parseInt(id.trim()))
                .filter(id => !isNaN(id));
            }
          } else {
            await DB.prepare(`
              INSERT OR IGNORE INTO group_configs (chat_id, chat_title, enabled, allowed_thread_ids)
              VALUES (?, ?, 1, '')
            `).bind(chatIdStr, chat.title || '未知群组').run();
          }
          
          if (!enabled) {
            shouldProcess = false;
          }
          
          if (shouldProcess && allowedThreadIds.length > 0) {
            if (!msg.message_thread_id || !allowedThreadIds.includes(msg.message_thread_id)) {
              shouldProcess = false;
            }
          }
        }
        
        if (!shouldProcess) {
          return new Response('OK', { status: 200 });
        }
        
        for (const block of codeBlocks) {
          const chatIdStr = chat?.id?.toString() || 'unknown';
          
          if (isEdit) {
            const existing = await DB.prepare(
              'SELECT id FROM methods WHERE chat_id = ? AND message_id = ?'
            ).bind(chatIdStr, messageId).first();
            
            if (existing) {
              let link = '';
              if (chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
                const chatUsername = chat.username;
                if (chatUsername) {
                  link = `https://t.me/${chatUsername}/${messageId}`;
                } else {
                  let channelId = chat.id.toString();
                  if (channelId.startsWith('-100')) {
                    channelId = channelId.slice(4);
                  } else if (channelId.startsWith('-')) {
                    channelId = channelId.slice(1);
                  }
                  link = `https://t.me/c/${channelId}/${messageId}`;
                }
              }
              
              const hash = await sha256(block.code);
              
              await DB.prepare(`
                UPDATE methods 
                SET title = ?, code = ?, tags = ?, link = ?, hash = ?, updated_at = strftime('%s', 'now')
                WHERE id = ?
              `).bind(
                block.title,
                block.code,
                block.tags.join(','),
                link,
                hash,
                existing.id
              ).run();
            }
          } else {
            const hash = await sha256(block.code);
            const existing = await DB.prepare('SELECT id FROM methods WHERE hash = ?').bind(hash).first();
            if (existing) continue;
            
            let link = '';
            if (chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
              const chatUsername = chat.username;
              if (chatUsername) {
                link = `https://t.me/${chatUsername}/${messageId}`;
              } else {
                let channelId = chat.id.toString();
                if (channelId.startsWith('-100')) {
                  channelId = channelId.slice(4);
                } else if (channelId.startsWith('-')) {
                  channelId = channelId.slice(1);
                }
                link = `https://t.me/c/${channelId}/${messageId}`;
              }
            }
            
            await DB.prepare(`
              INSERT INTO methods (title, code, tags, author, source, chat_id, message_id, link, hash)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
              block.title,
              block.code,
              block.tags.join(','),
              author,
              'telegram',
              chatIdStr,
              messageId,
              link,
              hash
            ).run();
          }
        }
        
        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error('Webhook error:', error);
        return new Response('OK', { status: 200 });
      }
    }
    
    // 设置 Webhook
    if (url.pathname === '/set-webhook' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return jsonResponse({ error: '需要管理员权限' }, 403);
      if (!BOT_TOKEN) return jsonResponse({ error: '未设置 BOT_TOKEN' }, 500);
      
      const webhookUrl = `${url.origin}/webhook`;
      const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          secret_token: WEBHOOK_SECRET,
          allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post', 'my_chat_member']
        })
      });
      return jsonResponse(await response.json());
    }
    
    // 获取历史消息
    if (url.pathname === '/api/fetch-history' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return jsonResponse({ error: '需要管理员权限' }, 403);
      if (!BOT_TOKEN) return jsonResponse({ error: '未设置 BOT_TOKEN' }, 500);
      
      try {
        const { chat_id, message_thread_id, limit = 100 } = await request.json();
        if (!chat_id) return jsonResponse({ error: '缺少 chat_id' }, 400);
        
        let processed = 0;
        let offset = 0;
        const batchSize = 100;
        
        while (offset < limit) {
          const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              offset: offset,
              limit: batchSize,
              allowed_updates: ['message', 'channel_post']
            })
          });
          
          const data = await response.json();
          if (!data.ok || !data.result || data.result.length === 0) break;
          
          for (const update of data.result) {
            const msg = update.message || update.channel_post;
            if (!msg) continue;
            
            if (msg.chat.id.toString() !== chat_id.toString()) continue;
            if (message_thread_id && msg.message_thread_id !== message_thread_id) continue;
            
            const messageText = msg.text || msg.caption || '';
            if (!messageText) continue;
            
            const codeBlocks = extractCodeBlocksFromMessage(msg, messageText);
            if (codeBlocks.length === 0) continue;
            
            const author = msg.from?.username || msg.chat?.username || 'anonymous';
            const messageId = msg.message_id;
            const chat = msg.chat;
            
            for (const block of codeBlocks) {
              const hash = await sha256(block.code);
              const existing = await DB.prepare('SELECT id FROM methods WHERE hash = ?').bind(hash).first();
              if (existing) continue;
              
              let link = '';
              if (chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
                const chatUsername = chat.username;
                if (chatUsername) {
                  link = `https://t.me/${chatUsername}/${messageId}`;
                } else {
                  let channelId = chat.id.toString();
                  if (channelId.startsWith('-100')) {
                    channelId = channelId.slice(4);
                  } else if (channelId.startsWith('-')) {
                    channelId = channelId.slice(1);
                  }
                  link = `https://t.me/c/${channelId}/${messageId}`;
                }
              }
              
              await DB.prepare(`
                INSERT INTO methods (title, code, tags, author, source, chat_id, message_id, link, hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                block.title,
                block.code,
                block.tags.join(','),
                author,
                'telegram_history',
                chat.id.toString(),
                messageId,
                link,
                hash
              ).run();
              
              processed++;
            }
          }
          
          offset += batchSize;
        }
        
        return jsonResponse({ success: true, processed });
      } catch (error) {
        return jsonResponse({ error: '获取历史消息失败', detail: error.message }, 500);
      }
    }
    
    // 获取群组配置列表
    if (url.pathname === '/api/group-configs' && request.method === 'GET') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return jsonResponse({ error: '需要管理员权限' }, 403);
      
      try {
        const { results } = await DB.prepare(`
          SELECT chat_id, chat_title, chat_type, enabled, allowed_thread_ids
          FROM group_configs
          ORDER BY updated_at DESC
        `).all();
        
        return jsonResponse({
          success: true,
          groups: results.map(g => ({
            chat_id: g.chat_id,
            chat_title: g.chat_title || '未知群组',
            chat_type: g.chat_type || 'group',
            enabled: g.enabled === 1,
            allowed_thread_ids: g.allowed_thread_ids || ''
          }))
        });
      } catch (error) {
        return jsonResponse({ error: '查询失败', detail: error.message }, 500);
      }
    }
    
    // 验证并清理失效群组（同时更新群组类型）
    if (url.pathname === '/api/group-configs/validate' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return jsonResponse({ error: '需要管理员权限' }, 403);
      if (!BOT_TOKEN) return jsonResponse({ error: '未设置 BOT_TOKEN' }, 500);
      
      try {
        const { results } = await DB.prepare('SELECT chat_id FROM group_configs').all();
        
        let removed = 0;
        let validated = 0;
        let updated = 0;
        
        // 获取 Bot 自己的 ID
        const meResponse = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getMe');
        const meData = await meResponse.json();
        const botId = meData.result.id;
        
        for (const group of results) {
          try {
            // 先获取群组信息
            const chatResponse = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getChat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: group.chat_id
              })
            });
            
            const chatData = await chatResponse.json();
            
            if (!chatData.ok) {
              // 群组不存在或 Bot 已被移除
              await DB.prepare('DELETE FROM group_configs WHERE chat_id = ?').bind(group.chat_id).run();
              await DB.prepare('DELETE FROM methods WHERE chat_id = ?').bind(group.chat_id).run();
              removed++;
              continue;
            }
            
            // 检查 Bot 是否是管理员
            const memberResponse = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/getChatMember', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: group.chat_id,
                user_id: botId
              })
            });
            
            const memberData = await memberResponse.json();
            
            if (!memberData.ok || !memberData.result || memberData.result.status !== 'administrator') {
              // Bot 不是管理员，删除记录
              await DB.prepare('DELETE FROM group_configs WHERE chat_id = ?').bind(group.chat_id).run();
              await DB.prepare('DELETE FROM methods WHERE chat_id = ?').bind(group.chat_id).run();
              removed++;
            } else {
              // 更新群组信息（包括类型和标题）
              const chatInfo = chatData.result;
              await DB.prepare(`
                UPDATE group_configs 
                SET chat_title = ?, chat_type = ?, updated_at = strftime('%s', 'now')
                WHERE chat_id = ?
              `).bind(chatInfo.title || '未知群组', chatInfo.type, group.chat_id).run();
              validated++;
              updated++;
            }
          } catch (e) {
            // API 调用失败，删除记录
            await DB.prepare('DELETE FROM group_configs WHERE chat_id = ?').bind(group.chat_id).run();
            await DB.prepare('DELETE FROM methods WHERE chat_id = ?').bind(group.chat_id).run();
            removed++;
          }
        }
        
        return jsonResponse({
          success: true,
          validated,
          removed,
          updated,
          message: '验证完成：' + validated + ' 个有效群组（已更新类型），' + removed + ' 个失效群组已清理'
        });
      } catch (error) {
        return jsonResponse({ error: '验证失败', detail: error.message }, 500);
      }
    }
    
    // 更新群组配置
    if (url.pathname.match(/^\/api\/group-configs\/[^\/]+$/) && request.method === 'PUT') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return jsonResponse({ error: '需要管理员权限' }, 403);
      
      const chatId = url.pathname.split('/').pop();
      try {
        const { enabled, allowed_thread_ids } = await request.json();
        
        await DB.prepare(`
          INSERT OR REPLACE INTO group_configs 
          (chat_id, chat_title, enabled, allowed_thread_ids, updated_at)
          VALUES (?, (SELECT chat_title FROM group_configs WHERE chat_id = ?), ?, ?, strftime('%s', 'now'))
        `).bind(chatId, chatId, enabled ? 1 : 0, allowed_thread_ids || '').run();
        
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: '更新失败', detail: error.message }, 500);
      }
    }
    
    // 获取方法列表
    if (url.pathname === '/api/methods' && request.method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const tag = url.searchParams.get('tag') || '';
      const verified = url.searchParams.get('verified');
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      
      let sql = 'SELECT * FROM methods WHERE 1=1';
      const params = [];
      
      if (query) {
        sql += ' AND (title LIKE ? OR code LIKE ? OR tags LIKE ?)';
        const searchPattern = `%${query}%`;
        params.push(searchPattern, searchPattern, searchPattern);
      }
      if (tag) {
        sql += ' AND tags LIKE ?';
        params.push(`%${tag}%`);
      }
      if (verified !== null) {
        sql += ' AND verified = ?';
        params.push(verified === 'true' ? 1 : 0);
      }
      
      sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);
      
      try {
        const { results } = await DB.prepare(sql).bind(...params).all();
        const { total = 0 } = await DB.prepare('SELECT COUNT(*) as total FROM methods').first() || {};
        
        return jsonResponse({
          success: true,
          methods: results.map(m => ({
            ...m,
            tags: m.tags ? m.tags.split(',') : [],
            verified: m.verified === 1
          })),
          total,
          limit,
          offset
        });
      } catch (error) {
        return jsonResponse({ error: '查询失败', detail: error.message }, 500);
      }
    }
    
    // 获取单个方法详情
    if (url.pathname.match(/^\/api\/methods\/\d+$/) && request.method === 'GET') {
      const id = url.pathname.split('/').pop();
      
      try {
        const method = await DB.prepare('SELECT * FROM methods WHERE id = ?').bind(id).first();
        if (!method) return jsonResponse({ error: '方法不存在' }, 404);
        
        return jsonResponse({
          success: true,
          method: {
            ...method,
            tags: method.tags ? method.tags.split(',') : [],
            verified: method.verified === 1
          }
        });
      } catch (error) {
        return jsonResponse({ error: '查询失败', detail: error.message }, 500);
      }
    }
    
    // 添加方法
    if (url.pathname === '/api/methods' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return jsonResponse({ error: '需要管理员权限' }, 403);
      
      try {
        const { title, code, tags = [], link = '' } = await request.json();
        if (!title || !code) return jsonResponse({ error: '缺少必要字段' }, 400);
        
        const hash = await sha256(code);
        const existing = await DB.prepare('SELECT id FROM methods WHERE hash = ?').bind(hash).first();
        if (existing) return jsonResponse({ error: '方法已存在', id: existing.id }, 409);
        
        const result = await DB.prepare(`
          INSERT INTO methods (title, code, tags, author, source, link, hash)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(title, code, tags.join(','), 'admin', 'manual', link, hash).run();
        
        return jsonResponse({ success: true, id: result.meta.last_row_id });
      } catch (error) {
        return jsonResponse({ error: '添加失败', detail: error.message }, 500);
      }
    }
    
    // 更新方法
    if (url.pathname.match(/^\/api\/methods\/\d+$/) && request.method === 'PUT') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return jsonResponse({ error: '需要管理员权限' }, 403);
      
      const id = url.pathname.split('/').pop();
      const { title, code, tags, verified, link } = await request.json();
      
      const updates = [];
      const params = [];
      
      if (title !== undefined) { updates.push('title = ?'); params.push(title); }
      if (code !== undefined) { 
        updates.push('code = ?', 'hash = ?', 'updated_at = strftime(\'%s\', \'now\')'); 
        params.push(code, await sha256(code)); 
      }
      if (tags !== undefined) { updates.push('tags = ?'); params.push(Array.isArray(tags) ? tags.join(',') : tags); }
      if (verified !== undefined) { updates.push('verified = ?'); params.push(verified ? 1 : 0); }
      if (link !== undefined) { updates.push('link = ?'); params.push(link); }
      
      if (updates.length === 0) return jsonResponse({ error: '没有需要更新的字段' }, 400);
      
      params.push(id);
      
      try {
        await DB.prepare(`UPDATE methods SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: '更新失败', detail: error.message }, 500);
      }
    }
    
    // 删除方法
    if (url.pathname.match(/^\/api\/methods\/\d+$/) && request.method === 'DELETE') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return jsonResponse({ error: '需要管理员权限' }, 403);
      
      const id = url.pathname.split('/').pop();
      
      try {
        await DB.prepare('DELETE FROM methods WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
      } catch (error) {
        return jsonResponse({ error: '删除失败', detail: error.message }, 500);
      }
    }
    
    // 导出所有方法
    if (url.pathname === '/api/export' && request.method === 'GET') {
      try {
        const { results } = await DB.prepare('SELECT * FROM methods ORDER BY created_at DESC').all();
        
        const methods = results.map(m => ({
          id: m.id,
          title: m.title,
          code: m.code,
          tags: m.tags ? m.tags.split(',') : [],
          verified: m.verified === 1,
          author: m.author,
          link: m.link,
          created_at: m.created_at,
          updated_at: m.updated_at
        }));
        
        return new Response(JSON.stringify(methods, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="methods.json"',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        return jsonResponse({ error: '导出失败', detail: error.message }, 500);
      }
    }
    
    // ShortX 专用接口
    if (url.pathname === '/api/shortx/methods.json') {
      try {
        const { results } = await DB.prepare(
          'SELECT id, title, code, tags FROM methods WHERE verified = 1 ORDER BY created_at DESC LIMIT 1000'
        ).all();
        
        const shortxFormat = results.map(m => ({
          id: m.id,
          name: m.title,
          code: m.code,
          tags: m.tags ? m.tags.split(',') : [],
          verified: true
        }));
        
        return new Response(JSON.stringify(shortxFormat, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        return jsonResponse({ error: '导出失败', detail: error.message }, 500);
      }
    }
    
    // 统计信息
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      try {
        const total = await DB.prepare('SELECT COUNT(*) as count FROM methods').first();
        const verified = await DB.prepare('SELECT COUNT(*) as count FROM methods WHERE verified = 1').first();
        
        const { results } = await DB.prepare('SELECT tags FROM methods WHERE tags IS NOT NULL AND tags != ""').all();
        const tagCounts = {};
        results.forEach(r => {
          if (r.tags) {
            r.tags.split(',').forEach(tag => {
              tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
          }
        });
        
        return jsonResponse({
          success: true,
          stats: {
            total: total.count,
            verified: verified.count,
            tags: Object.keys(tagCounts).length,
            tagCounts: tagCounts
          }
        });
      } catch (error) {
        return jsonResponse({ error: '统计失败', detail: error.message }, 500);
      }
    }
    
    // 获取所有标签
    if (url.pathname === '/api/tags' && request.method === 'GET') {
      try {
        const { results } = await DB.prepare('SELECT tags FROM methods WHERE tags IS NOT NULL AND tags != ""').all();
        const allTags = new Set();
        results.forEach(r => {
          if (r.tags) {
            r.tags.split(',').forEach(tag => allTags.add(tag.trim()));
          }
        });
        
        return jsonResponse({
          success: true,
          tags: Array.from(allTags).sort()
        });
      } catch (error) {
        return jsonResponse({ error: '查询失败', detail: error.message }, 500);
      }
    }
    
    return jsonResponse({ error: '未找到路径' }, 404);
  }
};

// ========== 辅助函数 ==========

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

const langMap = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  java: 'Java',
  mvel: 'MVEL'
};

function extractTagsFromMessage(text) {
  const tags = [];
  if (!text) return tags;
  
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') break;
    
    const words = line.split(/\s+/);
    let foundTag = false;
    
    for (const word of words) {
      if (word.startsWith('#') && word.length > 1) {
        const tag = word.substring(1);
        if (/^[\w\u4e00-\u9fa5\-_]+$/.test(tag)) {
          tags.unshift(tag);
          foundTag = true;
        }
      }
    }
    
    if (!foundTag) break;
  }
  
  return tags;
}

function extractCodeBlocksFromMessage(msg, text) {
  const codeBlocks = [];
  const tags = extractTagsFromMessage(text);
  
  if (msg.entities && Array.isArray(msg.entities)) {
    for (const entity of msg.entities) {
      if (entity.type === 'pre') {
        const code = text.substring(entity.offset, entity.offset + entity.length).trim();
        let language = entity.language || '未命名';
        language = langMap[language.toLowerCase()] || language;
        
        codeBlocks.push({ code, title: language, tags });
      }
    }
  }
  
  if (codeBlocks.length === 0) {
    const lines = text.split('\n');
    let endIndex = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (trimmed === '') continue;
      const words = trimmed.split(/\s+/);
      const isTagLine = words.every(w => w.startsWith('#') && w.length > 1);
      if (isTagLine) endIndex = i;
      else break;
    }
    const cleanedText = lines.slice(0, endIndex).join('\n').trim();
    
    const regex = /```(?:([\w]+))?\n?([\s\S]*?)```/gi;
    let match;
    while ((match = regex.exec(cleanedText)) !== null) {
      const code = match[2].trim();
      let language = match[1] || '未命名';
      language = langMap[language.toLowerCase()] || language;
      codeBlocks.push({ code, title: language, tags });
    }
  }
  
  if (codeBlocks.length === 0 && text.trim().length > 20) {
    const indicators = ['function', '=>', '{', '}', ';', 'let ', 'const '];
    if (indicators.filter(ind => text.includes(ind)).length >= 2) {
      codeBlocks.push({ code: text.trim(), title: '未命名方法', tags });
    }
  }
  
  return codeBlocks;
}

async function sha256(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ========== 前端页面 ==========
function getHTMLPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ShortX Method Hub</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .code-block pre { 
      white-space: pre-wrap; 
      word-break: break-all; 
      overflow-wrap: anywhere; 
      max-height: 360px;
      overflow-y: auto;
    }
    #toast {
      visibility: hidden;
      min-width: 250px;
      background-color: #10b981;
      color: white;
      text-align: center;
      border-radius: 8px;
      padding: 16px;
      position: fixed;
      z-index: 100;
      right: 30px;
      bottom: 30px;
      font-size: 17px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    #toast.show {
      visibility: visible;
      animation: fadein 0.5s, fadeout 0.5s 2.5s;
    }
    #toast.error {
      background-color: #ef4444;
    }
    @keyframes fadein {
      from {bottom: 0; opacity: 0;}
      to {bottom: 30px; opacity: 1;}
    }
    @keyframes fadeout {
      from {bottom: 30px; opacity: 1;}
      to {bottom: 0; opacity: 0;}
    }
    #mobile-menu {
      transition: max-height 0.3s ease-out, opacity 0.3s ease-out;
      max-height: 0;
      opacity: 0;
      overflow: hidden;
    }
    #mobile-menu.open {
      max-height: 800px;
      opacity: 1;
    }
  </style>
</head>
<body class="bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen">
  <div id="app" class="max-w-7xl mx-auto"></div>
  <div id="toast">操作成功！</div>
  <script>
    const API_BASE = location.origin;
    let ADMIN_KEY = localStorage.getItem('admin_key') || '';
    let currentTab = 'search';
    let methods = [];
    let stats = {};
    let groups = [];
    let searchQuery = '';
    let selectedTag = '';
    let showModal = false;
    let editing = null;
    let showDeleteConfirm = false;
    let deletingId = null;
    let showLogoutConfirm = false;
    let isSearching = false;
    let showHistoryModal = false;
    let historyFetching = false;
    let isValidating = false;

    async function init() {
      await Promise.all([loadMethods(), loadStats(), loadGroups()]);
      render();
    }

    async function loadMethods(q = '', tag = '') {
      isSearching = true;
      render();
      try {
        let url = \`\${API_BASE}/api/methods?limit=200\`;
        if (q) url += \`&q=\${encodeURIComponent(q)}\`;
        if (tag) url += \`&tag=\${encodeURIComponent(tag)}\`;
        const res = await fetch(url);
        const data = await res.json();
        methods = data.methods || [];
      } finally {
        isSearching = false;
        render();
      }
    }

    async function loadStats() {
      try {
        const res = await fetch(\`\${API_BASE}/api/stats\`);
        stats = (await res.json()).stats || {};
      } catch {}
    }

    async function loadGroups() {
      if (!ADMIN_KEY) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/group-configs\`, {
          headers: { 'X-Admin-Key': ADMIN_KEY }
        });
        const data = await res.json();
        groups = data.groups || [];
      } catch (e) {
        console.error('加载群组配置失败', e);
      }
    }

    function showToast(msg = '操作成功！', isError = false) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.className = 'show' + (isError ? ' error' : '');
      setTimeout(() => {
        toast.className = toast.className.replace('show', '');
      }, 3000);
    }

    function toggleMobileMenu() {
      const menu = document.getElementById('mobile-menu');
      menu.classList.toggle('open');
    }

    function mobileLogin() {
      const v = document.getElementById('mobile-pwd').value.trim();
      if (v) {
        ADMIN_KEY = v;
        localStorage.setItem('admin_key', v);
        loadGroups();
        render();
        toggleMobileMenu();
      }
    }

    async function performSearch(e) {
      if (e) e.preventDefault();
      await loadMethods(searchQuery, selectedTag);
    }

    async function performTagSearch(tag) {
      await loadMethods(searchQuery, tag);
    }

    function formatDateTime(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp * 1000);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      return \`\${year}-\${month}-\${day} \${hours}:\${minutes}:\${seconds}\`;
    }

    function render() {
      const allTags = [...new Set(methods.flatMap(m => m.tags || []))];
      document.getElementById('app').innerHTML = \`
        <header class="bg-white shadow-lg sticky top-0 z-20">
          <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-gradient-to-r from-purple-600 to-blue-600 rounded-lg">
                <svg class="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
              </div>
              <div>
                <h1 class="text-2xl font-bold bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">ShortX Method Hub</h1>
                <p class="text-gray-600 text-sm hidden md:block">方法知识库管理系统</p>
              </div>
            </div>

            <div class="hidden md:flex items-center gap-3">
              \${!ADMIN_KEY ? \`<input id="pwd" type="password" placeholder="管理员密钥" class="px-4 py-2 border rounded-lg text-sm">
              <button onclick="login()" class="px-5 py-2 bg-purple-600 text-white rounded-lg text-sm">登录</button>\` :
              \`<span class="bg-green-100 text-green-700 px-3 py-1.5 rounded-lg text-sm">管理员模式</span>
              <button onclick="showLogoutConfirm=true;render()" class="text-red-600 hover:underline text-sm">退出</button>\`}
            </div>

            <button onclick="toggleMobileMenu()" class="md:hidden text-gray-600 p-2">
              <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
              </svg>
            </button>
          </div>

          <div id="mobile-menu" class="md:hidden bg-white border-t">
            <div class="px-6 py-4 space-y-4">
              <button onclick="setTab('search');toggleMobileMenu()" class="\${currentTab==='search'?'text-purple-600 font-bold':'text-gray-700'} block w-full text-left py-2">搜索方法</button>
              \${ADMIN_KEY ? \`
              <button onclick="setTab('admin');toggleMobileMenu()" class="\${currentTab==='admin'?'text-purple-600 font-bold':'text-gray-700'} block w-full text-left py-2">管理面板</button>
              <button onclick="setTab('groups');toggleMobileMenu()" class="\${currentTab==='groups'?'text-purple-600 font-bold':'text-gray-700'} block w-full text-left py-2">群组配置</button>
              \` : ''}
              <button onclick="setTab('stats');toggleMobileMenu()" class="\${currentTab==='stats'?'text-purple-600 font-bold':'text-gray-700'} block w-full text-left py-2">统计信息</button>

              <div class="border-t pt-4">
                \${!ADMIN_KEY ? \`
                <input id="mobile-pwd" type="password" placeholder="管理员密钥" class="w-full px-4 py-2 border rounded-lg text-sm mb-2">
                <button onclick="mobileLogin()" class="w-full px-5 py-2 bg-purple-600 text-white rounded-lg text-sm">登录</button>
                \` : \`
                <div class="text-green-700 mb-2 text-sm">管理员模式</div>
                <button onclick="showLogoutConfirm=true;toggleMobileMenu();render()" class="w-full text-red-600 hover:underline py-2 text-left text-sm">退出登录</button>
                \`}
              </div>
            </div>
          </div>
        </header>

        <nav class="bg-white border-b hidden md:block">
          <div class="max-w-7xl mx-auto px-6">
            <div class="flex gap-8 py-4 overflow-x-auto">
              <button onclick="setTab('search')" class="\${currentTab==='search'?'text-purple-600 border-b-4 border-purple-600':'text-gray-600'} font-medium">搜索方法</button>
              \${ADMIN_KEY ? \`
              <button onclick="setTab('admin')" class="\${currentTab==='admin'?'text-purple-600 border-b-4 border-purple-600':'text-gray-600'} font-medium">管理面板</button>
              <button onclick="setTab('groups')" class="\${currentTab==='groups'?'text-purple-600 border-b-4 border-purple-600':'text-gray-600'} font-medium">群组配置</button>
              \` : ''}
              <button onclick="setTab('stats')" class="\${currentTab==='stats'?'text-purple-600 border-b-4 border-purple-600':'text-gray-600'} font-medium">统计信息</button>
            </div>
          </div>
        </nav>

        <main class="max-w-7xl mx-auto px-6 py-8">
          \${currentTab === 'search' ? searchView(allTags) : ''}
          \${currentTab === 'admin' && ADMIN_KEY ? adminView() : ''}
          \${currentTab === 'groups' && ADMIN_KEY ? groupsView() : ''}
          \${currentTab === 'stats' ? statsView() : ''}
          \${showModal ? modalView() : ''}
          \${showDeleteConfirm ? deleteConfirmView() : ''}
          \${showLogoutConfirm ? logoutConfirmView() : ''}
          \${showHistoryModal ? historyModalView() : ''}
        </main>
      \`;
    }

    function searchView(allTags) {
      return \`
        <div class="space-y-6">
          <div class="bg-white rounded-2xl shadow-lg p-6">
            <form onsubmit="performSearch(event)" class="flex gap-3 items-stretch">
              <input 
                id="search-input"
                type="text" 
                placeholder="搜索标题、代码或标签..." 
                value="\${searchQuery}" 
                oninput="searchQuery=this.value" 
                class="flex-1 min-w-0 px-5 py-3 border-2 rounded-xl focus:border-purple-600 outline-none"
              >
              <button 
                type="submit" 
                class="px-4 sm:px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition flex items-center justify-center gap-2 flex-shrink-0"
              >
                <svg class="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                </svg>
                <span class="hidden sm:inline whitespace-nowrap">搜索</span>
              </button>
            </form>
            <div class="flex flex-wrap gap-3 mt-6">
              <button onclick="selectedTag='';performTagSearch('')" class="px-4 py-2 rounded-full \${selectedTag===''?'bg-purple-600 text-white':'bg-gray-100 hover:bg-gray-200'} transition">全部</button>
              \${allTags.map(t => \`<button onclick="selectedTag='\${t}';performTagSearch('\${t}')" class="px-4 py-2 rounded-full \${selectedTag===t?'bg-purple-600 text-white':'bg-gray-100 hover:bg-gray-200'} transition">#\${t}</button>\`).join('')}
            </div>
          </div>
          \${isSearching ? \`
            <div class="flex items-center justify-center py-12">
              <div class="flex items-center gap-3 text-purple-600">
                <svg class="animate-spin h-8 w-8" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span class="text-lg font-medium">正在搜索...</span>
              </div>
            </div>
          \` : \`
            <div class="columns-1 gap-6 sm:columns-2 md:columns-3 lg:columns-4">
              \${methods.map(m => card(m, false)).join('')}
            </div>
            \${methods.length === 0 ? '<p class="text-center py-12 text-gray-500">暂无匹配的方法</p>' : ''}
          \`}
        </div>
      \`;
    }

    function adminView() {
      return \`
        <div class="space-y-6">
          <div class="flex justify-between items-center flex-wrap gap-4">
            <h2 class="text-3xl font-bold">管理面板</h2>
            <div class="flex gap-3 flex-wrap">
              <button onclick="openModal()" class="px-6 py-3 bg-green-600 text-white rounded-xl hover:bg-green-700 transition">+ 添加方法</button>
              <button onclick="location='\${API_BASE}/api/export'" class="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition">导出 JSON</button>
              <button onclick="location='\${API_BASE}/api/shortx/methods.json'" class="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition">ShortX 格式</button>
            </div>
          </div>
          <div class="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <p class="text-amber-800">点击 ✓ 标记已验证，仅已验证方法会出现在 ShortX 接口。获取历史消息请前往"群组配置"页面。</p>
          </div>
          <div class="columns-1 gap-6 sm:columns-2 md:columns-3 lg:columns-4">
            \${methods.map(m => card(m, true)).join('')}
          </div>
        </div>
      \`;
    }

    function card(m, admin) {
      return \`
        <div class="bg-white rounded-2xl shadow-lg break-inside-avoid mb-6 overflow-hidden flex flex-col">
          <div class="p-5 flex flex-col flex-1">
            <div class="flex justify-between items-start mb-3">
              <h3 class="text-lg font-bold flex items-center gap-2 flex-wrap">
                \${esc(m.title)}
                \${m.verified ? '<span class="inline-flex items-center px-2.5 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">✓ 已验证</span>' : ''}
              </h3>
              \${!admin ? \`<button onclick="copyCode(\${m.id})" class="px-4 py-2 bg-purple-600 text-white text-sm rounded-lg hover:bg-purple-700 transition flex-shrink-0">复制</button>\` : ''}
            </div>
            <div class="text-xs text-gray-500 mb-3 space-y-1">
              <div class="flex flex-wrap gap-2 items-center">
                <span>👤 \${m.author || 'anonymous'}</span>
                \${m.link ? \`<a href="\${m.link}" target="_blank" class="text-blue-600 hover:underline">来源</a>\` : ''}
              </div>
              <div class="flex flex-col gap-0.5">
                <span>📅 创建: \${formatDateTime(m.created_at)}</span>
                \${m.updated_at ? \`<span class="text-orange-600">🔄 更新: \${formatDateTime(m.updated_at)}</span>\` : ''}
              </div>
            </div>
            <div class="code-block flex-1 mb-4">
              <pre class="bg-gray-50 rounded-lg p-3 text-xs border"><code>\${esc(m.code)}</code></pre>
            </div>
            <div class="flex flex-wrap gap-1.5">
              \${(m.tags||[]).map(t => \`<span class="px-2.5 py-1 bg-purple-100 text-purple-700 rounded-full text-xs font-medium">#\${t}</span>\`).join('')}
            </div>
            \${admin ? \`
              <div class="flex justify-end gap-2 mt-4 pt-3 border-t">
                <button onclick="verify(\${m.id},\${m.verified})" class="p-2 rounded-lg \${m.verified?'bg-green-100 text-green-700':'bg-gray-100'} hover:opacity-80 transition text-sm">✓</button>
                <button onclick="edit(\${m.id})" class="p-2 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition text-sm">编辑</button>
                <button onclick="confirmDelete(\${m.id})" class="p-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition text-sm">删除</button>
              </div>
            \` : ''}
          </div>
        </div>
      \`;
    }

    function groupsView() {
      const getChatTypeText = (type) => {
        const types = {
          'group': '普通群组',
          'supergroup': '超级群组',
          'channel': '频道'
        };
        return types[type] || type;
      };

      const getChatTypeBadge = (type) => {
        const badges = {
          'group': 'bg-blue-100 text-blue-700',
          'supergroup': 'bg-purple-100 text-purple-700',
          'channel': 'bg-green-100 text-green-700'
        };
        return badges[type] || 'bg-gray-100 text-gray-700';
      };

      return \`
        <div class="space-y-8">
          <div class="flex justify-between items-center flex-wrap gap-4">
            <h2 class="text-3xl font-bold">群组配置</h2>
            <div class="flex gap-3">
              <button onclick="validateGroups()" class="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition flex items-center gap-2" \${isValidating ? 'disabled' : ''}>
                \${isValidating ? \`
                  <svg class="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  验证中...
                \` : \`
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                  </svg>
                  清理失效
                \`}
              </button>
              <button onclick="loadGroups();render()" class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">刷新列表</button>
            </div>
          </div>
          <div class="bg-white rounded-2xl shadow-lg p-6">
            <p class="text-gray-600 mb-6">配置 Bot 从哪些群组和话题采集方法。注意：Bot 必须是管理员才能工作。</p>
            <div class="space-y-6">
              \${groups.length === 0 ? '<p class="text-gray-500 text-center py-8">暂无群组（将 Bot 添加为群组管理员后会自动出现）</p>' : ''}
              \${groups.map(g => \`
                <div class="border border-gray-200 rounded-xl p-6 hover:shadow-md transition">
                  <div class="flex items-center justify-between mb-4 flex-wrap gap-4">
                    <div>
                      <div class="flex items-center gap-2 mb-1">
                        <h3 class="text-xl font-semibold">\${esc(g.chat_title)}</h3>
                        <span class="px-2 py-1 rounded-full text-xs font-medium \${getChatTypeBadge(g.chat_type)}">
                          \${getChatTypeText(g.chat_type)}
                        </span>
                      </div>
                      <p class="text-sm text-gray-500">Chat ID: \${g.chat_id}</p>
                    </div>
                    <label class="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" \${g.enabled ? 'checked' : ''} onchange="updateGroup('\${g.chat_id}', this.checked, document.getElementById('threads-\${g.chat_id.replace(/-/g,'_')}').value)" class="sr-only peer">
                      <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                      <span class="ml-3 text-sm font-medium text-gray-900">\${g.enabled ? '已启用' : '已禁用'}</span>
                    </label>
                  </div>
                  <div class="space-y-4">
                    \${g.chat_type === 'supergroup' ? \`
                      <div>
                        <label class="block text-sm font-medium text-gray-700 mb-2">
                          允许采集的话题 ID（逗号分隔，留空表示所有话题）
                        </label>
                        <div class="flex gap-2">
                          <input id="threads-\${g.chat_id.replace(/-/g,'_')}" type="text" value="\${esc(g.allowed_thread_ids)}" placeholder="例如: 123,456,789" class="flex-1 min-w-0 px-4 py-2 border border-gray-300 rounded-lg focus:border-purple-600 outline-none text-sm">
                          <button onclick="updateGroup('\${g.chat_id}', document.querySelector('input[onchange*=\\'\${g.chat_id}\\']').checked, document.getElementById('threads-\${g.chat_id.replace(/-/g,'_')}').value)" class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition whitespace-nowrap flex-shrink-0 text-sm">保存</button>
                        </div>
                      </div>
                    \` : \`
                      <input type="hidden" id="threads-\${g.chat_id.replace(/-/g,'_')}" value="">
                      <div class="text-sm text-gray-500 italic">
                        \${g.chat_type === 'channel' ? '📢 频道不支持话题功能' : '💬 普通群组不支持话题功能'}
                      </div>
                    \`}
                    <div class="flex gap-2 pt-2 border-t">
                      <button onclick="openHistoryModal('\${g.chat_id}', '')" class="flex-1 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition text-sm flex items-center justify-center gap-2">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                        </svg>
                        获取全部历史
                      </button>
                      \${g.chat_type === 'supergroup' && g.allowed_thread_ids ? \`
                        <button onclick="openHistoryModal('\${g.chat_id}', '\${g.allowed_thread_ids.split(',')[0]}')" class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition text-sm flex items-center justify-center gap-2">
                          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z"/>
                          </svg>
                          获取话题历史
                        </button>
                      \` : ''}
                    </div>
                  </div>
                </div>
              \`).join('')}
            </div>
          </div>
        </div>
      \`;
    }

    async function validateGroups() {
      isValidating = true;
      render();

      try {
        const res = await fetch(\`\${API_BASE}/api/group-configs/validate\`, {
          method: 'POST',
          headers: { 'X-Admin-Key': ADMIN_KEY }
        });

        const data = await res.json();
        
        if (data.success) {
          showToast(\`\${data.message}\`);
          await loadGroups();
        } else {
          showToast(data.error || '验证失败', true);
        }
      } catch (error) {
        showToast('验证失败: ' + error.message, true);
      } finally {
        isValidating = false;
        render();
      }
    }

    async function updateGroup(chatId, enabled, threadIds) {
      try {
        await fetch(\`\${API_BASE}/api/group-configs/\${chatId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
          body: JSON.stringify({ enabled, allowed_thread_ids: threadIds })
        });
        showToast('配置保存成功');
        await loadGroups();
        render();
      } catch (e) {
        showToast('保存失败', true);
      }
    }

    function statsView() {
      return \`
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div class="bg-white rounded-2xl shadow-lg p-8 text-center">
            <p class="text-gray-600 mb-2">总方法数</p>
            <p class="text-5xl font-bold text-purple-600">\${stats.total || 0}</p>
          </div>
          <div class="bg-white rounded-2xl shadow-lg p-8 text-center">
            <p class="text-gray-600 mb-2">已验证</p>
            <p class="text-5xl font-bold text-green-600">\${stats.verified || 0}</p>
          </div>
          <div class="bg-white rounded-2xl shadow-lg p-8 text-center">
            <p class="text-gray-600 mb-2">标签种类</p>
            <p class="text-5xl font-bold text-blue-600">\${stats.tags || 0}</p>
          </div>
        </div>
      \`;
    }

    function historyModalView() {
      return \`
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div class="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-8">
            <h3 class="text-2xl font-bold mb-6">获取历史消息</h3>
            <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 mb-6">
              <p class="text-blue-800 text-sm">
                <strong>提示：</strong>将从指定群组/话题获取历史消息中的代码块，自动去重后添加到数据库。
              </p>
            </div>
            <div class="space-y-4 mb-6">
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">Chat ID</label>
                <input id="history-chat-id" type="text" placeholder="-100xxxxxxxxxx" readonly class="w-full px-5 py-3 border rounded-xl bg-gray-50">
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">话题 ID</label>
                <input id="history-thread-id" type="text" placeholder="留空表示获取所有消息" readonly class="w-full px-5 py-3 border rounded-xl bg-gray-50">
              </div>
              <div>
                <label class="block text-sm font-medium text-gray-700 mb-2">获取数量</label>
                <input id="history-limit" type="number" value="100" min="1" max="500" class="w-full px-5 py-3 border rounded-xl">
                <p class="text-xs text-gray-500 mt-1">最多获取多少条历史消息（1-500）</p>
              </div>
            </div>
            \${historyFetching ? \`
              <div class="flex items-center justify-center py-8">
                <div class="flex items-center gap-3 text-purple-600">
                  <svg class="animate-spin h-8 w-8" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span class="text-lg font-medium">正在获取历史消息...</span>
                </div>
              </div>
            \` : \`
              <div class="flex justify-end gap-4">
                <button onclick="showHistoryModal=false;render()" class="px-6 py-3 bg-gray-300 rounded-xl hover:bg-gray-400 transition">取消</button>
                <button onclick="fetchHistory()" class="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition">开始获取</button>
              </div>
            \`}
          </div>
        </div>
      \`;
    }

    function openHistoryModal(chatId, threadId) {
      showHistoryModal = true;
      render();
      // 等待 DOM 渲染完成后填充值
      setTimeout(() => {
        document.getElementById('history-chat-id').value = chatId;
        document.getElementById('history-thread-id').value = threadId;
      }, 0);
    }

    async function fetchHistory() {
      const chatId = document.getElementById('history-chat-id').value.trim();
      const threadId = document.getElementById('history-thread-id').value.trim();
      const limit = parseInt(document.getElementById('history-limit').value) || 100;

      if (!chatId) {
        showToast('请输入 Chat ID', true);
        return;
      }

      historyFetching = true;
      render();

      try {
        const body = { chat_id: chatId, limit };
        if (threadId) body.message_thread_id = parseInt(threadId);

        const res = await fetch(\`\${API_BASE}/api/fetch-history\`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Key': ADMIN_KEY
          },
          body: JSON.stringify(body)
        });

        const data = await res.json();
        
        if (data.success) {
          showToast(\`成功获取 \${data.processed} 条方法！\`);
          showHistoryModal = false;
          await loadMethods();
          await loadStats();
        } else {
          showToast(data.error || '获取失败', true);
        }
      } catch (error) {
        showToast('获取历史消息失败: ' + error.message, true);
      } finally {
        historyFetching = false;
        render();
      }
    }

    function modalView() {
      const m = editing || {title:'',code:'',tags:[],link:''};
      return \`
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div class="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-8">
            <h3 class="text-2xl font-bold mb-6">\${editing?'编辑方法':'添加方法'}</h3>
            <input id="m-title" value="\${esc(m.title)}" placeholder="标题" class="w-full px-5 py-3 border rounded-xl mb-4">
            <textarea id="m-code" rows="12" placeholder="代码" class="w-full px-5 py-3 border rounded-xl font-mono text-sm mb-4">\${esc(m.code)}</textarea>
            <input id="m-tags" value="\${(m.tags||[]).join(', ')}" placeholder="标签 (逗号分隔)" class="w-full px-5 py-3 border rounded-xl mb-4">
            <input id="m-link" value="\${m.link||''}" placeholder="来源链接 (可选)" class="w-full px-5 py-3 border rounded-xl mb-6">
            <div class="flex justify-end gap-4">
              <button onclick="showModal=false;editing=null;render()" class="px-6 py-3 bg-gray-300 rounded-xl hover:bg-gray-400 transition">取消</button>
              <button onclick="save()" class="px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition">保存</button>
            </div>
          </div>
        </div>
      \`;
    }

    function deleteConfirmView() {
      const m = methods.find(x => x.id === deletingId);
      if (!m) return '';
      return \`
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
            <h3 class="text-2xl font-bold text-red-600 mb-4">确认删除</h3>
            <p class="text-gray-700 mb-6">确定要永久删除以下方法吗？此操作不可恢复。</p>
            <div class="bg-gray-50 rounded-xl p-4 mb-6">
              <p class="font-semibold">\${esc(m.title)}</p>
              <p class="text-sm text-gray-500 mt-2">作者: \${m.author || 'anonymous'}</p>
            </div>
            <div class="flex justify-end gap-4">
              <button onclick="showDeleteConfirm=false;deletingId=null;render()" class="px-6 py-3 bg-gray-300 rounded-xl hover:bg-gray-400 transition">取消</button>
              <button onclick="doDelete()" class="px-6 py-3 bg-red-600 text-white rounded-xl hover:bg-red-700 transition">删除</button>
            </div>
          </div>
        </div>
      \`;
    }

    function logoutConfirmView() {
      return \`
        <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
            <h3 class="text-2xl font-bold text-orange-600 mb-4">退出登录</h3>
            <p class="text-gray-700 mb-6">确定要退出管理员模式吗？</p>
            <div class="flex justify-end gap-4">
              <button onclick="showLogoutConfirm=false;render()" class="px-6 py-3 bg-gray-300 rounded-xl hover:bg-gray-400 transition">取消</button>
              <button onclick="doLogout()" class="px-6 py-3 bg-orange-600 text-white rounded-xl hover:bg-orange-700 transition">退出</button>
            </div>
          </div>
        </div>
      \`;
    }

    function setTab(t) { currentTab = t; loadMethods(); render(); }

    function login() { 
      const v = document.getElementById('pwd').value.trim(); 
      if (v) { 
        ADMIN_KEY = v; 
        localStorage.setItem('admin_key', v); 
        loadGroups(); 
        render(); 
      } 
    }

    function copyCode(id) {
      const m = methods.find(x => x.id === id);
      if (!m) return;
      navigator.clipboard.writeText(m.code).then(() => {
        showToast('代码已复制！');
      }).catch(() => {
        alert('复制失败，请手动选择代码复制');
      });
    }

    function openModal() { editing = null; showModal = true; render(); }

    function edit(id) { editing = methods.find(m => m.id === id); showModal = true; render(); }

    async function save() {
      const title = document.getElementById('m-title').value.trim();
      const code = document.getElementById('m-code').value.trim();
      const tags = document.getElementById('m-tags').value.split(',').map(t => t.trim()).filter(t => t);
      const link = document.getElementById('m-link').value.trim();
      if (!title || !code) {
        showToast('标题和代码不能为空', true);
        return;
      }
      const body = { title, code, tags, link };
      const url = editing ? \`\${API_BASE}/api/methods/\${editing.id}\` : \`\${API_BASE}/api/methods\`;
      
      try {
        const res = await fetch(url, { 
          method: editing ? 'PUT' : 'POST', 
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY }, 
          body: JSON.stringify(body) 
        });
        const data = await res.json();
        
        if (data.success || res.ok) {
          showToast(editing ? '更新成功！' : '添加成功！');
          showModal = false; 
          editing = null; 
          await loadMethods(); 
          await loadStats();
          render();
        } else {
          showToast(data.error || '操作失败', true);
        }
      } catch (error) {
        showToast('操作失败: ' + error.message, true);
      }
    }

    async function verify(id, v) {
      try {
        await fetch(\`\${API_BASE}/api/methods/\${id}\`, { 
          method: 'PUT', 
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY }, 
          body: JSON.stringify({ verified: !v }) 
        });
        showToast(v ? '已取消验证' : '已标记为验证');
        await loadMethods();
        await loadStats();
        render();
      } catch (error) {
        showToast('操作失败', true);
      }
    }

    function confirmDelete(id) {
      deletingId = id;
      showDeleteConfirm = true;
      render();
    }

    async function doDelete() {
      if (!deletingId) return;
      try {
        await fetch(\`\${API_BASE}/api/methods/\${deletingId}\`, { 
          method: 'DELETE', 
          headers: { 'X-Admin-Key': ADMIN_KEY } 
        });
        showToast('删除成功！');
        showDeleteConfirm = false;
        deletingId = null;
        await loadMethods();
        await loadStats();
        render();
      } catch (error) {
        showToast('删除失败', true);
      }
    }

    function doLogout() {
      ADMIN_KEY = '';
      localStorage.removeItem('admin_key');
      currentTab = 'search';
      showLogoutConfirm = false;
      groups = [];
      render();
    }

    function esc(t) { 
      const d = document.createElement('div'); 
      d.textContent = t; 
      return d.innerHTML; 
    }

    window.addEventListener('DOMContentLoaded', init);
  </script>
</body>
</html>`;
}