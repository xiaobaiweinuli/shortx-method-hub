
// Cloudflare Worker - ShortX Method Hub (增强修复版)
export default {
  async fetch(request, env, ctx) {
    // ========== 响应工具函数 ==========
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    };

    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    function errorResponse(message, status = 500, detail = null) {
      const response = { error: message };
      if (detail) response.detail = detail instanceof Error ? detail.message : detail;
      return jsonResponse(response, status);
    }

    // ========== 辅助函数 ==========
    const langMap = {
      js: 'JavaScript',
      javascript: 'JavaScript',
      java: 'Java',
      mvel: 'MVEL',
      python: 'Python',
      py: 'Python',
      php: 'PHP',
      html: 'HTML',
      css: 'CSS',
      sql: 'SQL',
      json: 'JSON',
      xml: 'XML'
    };

    function getAuthor(msg) {
      if (msg.forward_from) {
        const from = msg.forward_from;
        return from.username || 
               from.first_name || 
               (from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name) || 
               'anonymous';
      }
      
      if (msg.forward_from_chat) {
        const chat = msg.forward_from_chat;
        if (msg.forward_signature) return msg.forward_signature;
        return chat.username || chat.title || 'anonymous';
      }
      
      if (msg.forward_signature) return msg.forward_signature;
      
      if (msg.from) {
        const from = msg.from;
        return from.username || 
               from.first_name || 
               (from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name) || 
               'anonymous';
      }
      
      if (msg.chat) return msg.chat.username || msg.chat.title || 'anonymous';
      
      return 'anonymous';
    }

    function generateTelegramLink(chat, messageId) {
      if (!chat || !messageId) return '';
      const chatUsername = chat.username;
      if (chatUsername) return `https://t.me/${chatUsername}/${messageId}`;
      
      let channelId = chat.id.toString();
      if (channelId.startsWith('-100')) channelId = channelId.slice(4);
      else if (channelId.startsWith('-')) channelId = channelId.slice(1);
      return `https://t.me/c/${channelId}/${messageId}`;
    }

    function generateTelegramLinkFromId(chatId, messageId) {
      if (!chatId || !messageId) return '';
      const chatIdStr = chatId.toString();
      if (chatIdStr.startsWith('@')) {
        const username = chatIdStr.substring(1);
        return `https://t.me/${username}/${messageId}`;
      }
      
      let channelId = chatIdStr;
      if (channelId.startsWith('-100')) channelId = channelId.slice(4);
      else if (channelId.startsWith('-')) channelId = channelId.slice(1);
      return `https://t.me/c/${channelId}/${messageId}`;
    }

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
        const indicators = ['function', '=>', '{', '}', ';', 'let ', 'const ', 'var ', 'def ', 'class ', 'import ', 'export '];
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

    // ========== 数据库服务类 ==========
    class DatabaseService {
      constructor(db) {
        this.db = db;
      }

      async initializeDatabase() {
        await this.db.prepare(`
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
        
        await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_hash ON methods(hash)`).run();
        await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_tags ON methods(tags)`).run();
        await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_verified ON methods(verified)`).run();
        await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_chat_message ON methods(chat_id, message_id)`).run();
        
        await this.db.prepare(`
          CREATE TABLE IF NOT EXISTS group_configs (
            chat_id TEXT PRIMARY KEY,
            chat_title TEXT,
            chat_type TEXT,
            enabled INTEGER DEFAULT 1,
            allowed_thread_ids TEXT DEFAULT '',
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
          )
        `).run();
        
        await this.db.prepare(`
          CREATE TABLE IF NOT EXISTS system_configs (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at INTEGER DEFAULT (strftime('%s', 'now'))
          )
        `).run();
        
        // 添加搜索会话表
        await this.db.prepare(`
          CREATE TABLE IF NOT EXISTS search_sessions (
            id TEXT PRIMARY KEY,
            chat_id TEXT NOT NULL,
            message_thread_id TEXT,
            query TEXT NOT NULL,
            results TEXT NOT NULL,
            current_index INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s', 'now')),
            updated_at INTEGER
          )
        `).run();
        
        await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_search_sessions_chat ON search_sessions(chat_id, message_thread_id)`).run();
        await this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_search_sessions_created ON search_sessions(created_at)`).run();
        
        const defaultConfigs = [
          ['shortx_require_verified', '1'],
          ['forward_method', 'in_situ'],
          ['forward_api', 'forwardMessage'],
          ['auto_delete', '1'],
          ['admin_user_id', ''],
          ['forward_target', ''],
          ['forward_thread_id', ''],
          ['enable_bot_search', '1'],
          ['bot_language', 'zh']
        ];
        
        for (const [key, value] of defaultConfigs) {
          await this.db.prepare(`
            INSERT OR IGNORE INTO system_configs (key, value)
            VALUES (?, ?)
          `).bind(key, value.toString()).run();
        }
      }

      async getMethods({ query, tag, verified, limit, offset }) {
        let sql = 'SELECT * FROM methods WHERE 1=1';
        let countSql = 'SELECT COUNT(*) as total FROM methods WHERE 1=1';
        const params = [];
        const countParams = [];
        
        if (query) {
          const searchTerms = query.split(/\s+/).filter(term => term.length > 0);
          if (searchTerms.length > 0) {
            const conditions = [];
            searchTerms.forEach(term => {
              conditions.push('(title LIKE ? OR code LIKE ? OR tags LIKE ?)');
              const searchPattern = `%${term}%`;
              params.push(searchPattern, searchPattern, searchPattern);
              countParams.push(searchPattern, searchPattern, searchPattern);
            });
            
            sql += ' AND ' + conditions.join(' AND ');
            countSql += ' AND ' + conditions.join(' AND ');
          }
        }
        
        if (tag) {
          sql += ' AND tags LIKE ?';
          countSql += ' AND tags LIKE ?';
          params.push(`%${tag}%`);
          countParams.push(`%${tag}%`);
        }
        
        if (verified === 'true' || verified === 'false') {
          sql += ' AND verified = ?';
          countSql += ' AND verified = ?';
          const verifiedValue = verified === 'true' ? 1 : 0;
          params.push(verifiedValue);
          countParams.push(verifiedValue);
        }
        
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        
        const { results } = await this.db.prepare(sql).bind(...params).all();
        const countResult = await this.db.prepare(countSql).bind(...countParams).first();
        const total = countResult ? countResult.total : 0;
        
        const methods = results.map(m => ({
          ...m,
          tags: m.tags ? m.tags.split(',') : [],
          verified: m.verified === 1
        }));
        
        return { methods, total };
      }

      async getMethodById(id) {
        const method = await this.db.prepare('SELECT * FROM methods WHERE id = ?').bind(id).first();
        if (!method) return null;
        
        return {
          ...method,
          tags: method.tags ? method.tags.split(',') : [],
          verified: method.verified === 1
        };
      }

      async createMethod({ title, code, tags = [], link = '', author = 'admin', source = 'manual' }) {
        if (!title || !code) throw new Error('缺少必要字段');
        
        const hash = await sha256(code);
        const existing = await this.db.prepare('SELECT id FROM methods WHERE hash = ?').bind(hash).first();
        if (existing) throw { code: 'EXISTS', id: existing.id };
        
        const result = await this.db.prepare(`
          INSERT INTO methods (title, code, tags, author, source, link, hash)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(title, code, tags.join(','), author, source, link, hash).run();
        
        return { id: result.meta.last_row_id };
      }

      async updateMethod(id, { title, code, tags, verified, link }) {
        const updates = [];
        const params = [];
        
        if (title !== undefined) { updates.push('title = ?'); params.push(title); }
        if (code !== undefined) { 
          updates.push('code = ?', 'hash = ?', 'updated_at = strftime(\'%s\', \'now\')'); 
          params.push(code, await sha256(code)); 
        }
        if (tags !== undefined) { 
          updates.push('tags = ?'); 
          params.push(Array.isArray(tags) ? tags.join(',') : tags); 
        }
        if (verified !== undefined) { 
          updates.push('verified = ?'); 
          params.push(verified ? 1 : 0); 
        }
        if (link !== undefined) { 
          updates.push('link = ?'); 
          params.push(link); 
        }
        
        if (updates.length === 0) throw new Error('没有需要更新的字段');
        
        params.push(id);
        await this.db.prepare(`UPDATE methods SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();
      }

      async deleteMethod(id) {
        await this.db.prepare('DELETE FROM methods WHERE id = ?').bind(id).run();
      }

      async exportMethods() {
        const { results } = await this.db.prepare('SELECT * FROM methods ORDER BY created_at DESC').all();
        return results.map(m => ({
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
      }

      async getMethodsForShortX(configs) {
        const requireVerified = configs.shortx_require_verified !== '0';
        
        let sql = 'SELECT id, title, code, tags FROM methods';
        if (requireVerified) sql += ' WHERE verified = 1';
        sql += ' ORDER BY created_at DESC LIMIT 1000';
        
        const { results } = await this.db.prepare(sql).all();
        
        return results.map(m => ({
          id: m.id,
          name: m.title,
          code: m.code,
          tags: m.tags ? m.tags.split(',') : [],
          verified: true
        }));
      }

      async getStats() {
        const total = await this.db.prepare('SELECT COUNT(*) as count FROM methods').first();
        const verified = await this.db.prepare('SELECT COUNT(*) as count FROM methods WHERE verified = 1').first();
        
        const { results } = await this.db.prepare('SELECT tags FROM methods WHERE tags IS NOT NULL AND tags != ""').all();
        const tagCounts = {};
        results.forEach(r => {
          if (r.tags) {
            r.tags.split(',').forEach(tag => {
              tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
          }
        });
        
        return {
          total: total.count,
          verified: verified.count,
          tags: Object.keys(tagCounts).length,
          tagCounts
        };
      }

      async getTags() {
        const { results } = await this.db.prepare('SELECT tags FROM methods WHERE tags IS NOT NULL AND tags != ""').all();
        const allTags = new Set();
        results.forEach(r => {
          if (r.tags) {
            r.tags.split(',').forEach(tag => allTags.add(tag.trim()));
          }
        });
        
        return Array.from(allTags).sort();
      }

      async searchMethodsForBot(query, limit = 10, offset = 0) {
        let sql = 'SELECT * FROM methods WHERE 1=1';
        const params = [];
        
        if (query) {
          const searchTerms = query.split(/\s+/).filter(term => term.length > 0);
          if (searchTerms.length > 0) {
            const conditions = [];
            searchTerms.forEach(term => {
              conditions.push('(title LIKE ? OR code LIKE ? OR tags LIKE ?)');
              const searchPattern = `%${term}%`;
              params.push(searchPattern, searchPattern, searchPattern);
            });
            
            sql += ' AND ' + conditions.join(' AND ');
          }
        }
        
        sql += ' ORDER BY verified DESC, created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);
        
        const { results } = await this.db.prepare(sql).bind(...params).all();
        
        return results.map(m => ({
          ...m,
          tags: m.tags ? m.tags.split(',') : [],
          verified: m.verified === 1
        }));
      }

      async getRandomMethod() {
        // 增加重试机制
        let retryCount = 0;
        const maxRetries = 3;
        
        while (retryCount < maxRetries) {
          try {
            const { results } = await this.db.prepare(`
              SELECT * FROM methods 
              WHERE verified = 1 
              ORDER BY RANDOM() 
              LIMIT 1
            `).all();
            
            if (results.length === 0) {
              // 如果没有已验证方法，获取任何随机方法
              const { results: allResults } = await this.db.prepare(`
                SELECT * FROM methods 
                ORDER BY RANDOM() 
                LIMIT 1
              `).all();
              
              if (allResults.length === 0) return null;
              
              return {
                ...allResults[0],
                tags: allResults[0].tags ? allResults[0].tags.split(',') : [],
                verified: allResults[0].verified === 1
              };
            }
            
            return {
              ...results[0],
              tags: results[0].tags ? results[0].tags.split(',') : [],
              verified: results[0].verified === 1
            };
          } catch (error) {
            retryCount++;
            if (retryCount < maxRetries) {
              // 等待一段时间后重试
              await new Promise(resolve => setTimeout(resolve, 100 * retryCount));
            } else {
              throw error;
            }
          }
        }
        
        return null;
      }

      async getMethodsByTag(tag, limit = 10, offset = 0) {
        const { results } = await this.db.prepare(`
          SELECT * FROM methods 
          WHERE tags LIKE ? 
          ORDER BY verified DESC, created_at DESC 
          LIMIT ? OFFSET ?
        `).bind(`%${tag}%`, limit, offset).all();
        
        return results.map(m => ({
          ...m,
          tags: m.tags ? m.tags.split(',') : [],
          verified: m.verified === 1
        }));
      }

      async getMethodCount() {
        const result = await this.db.prepare('SELECT COUNT(*) as count FROM methods').first();
        return result ? result.count : 0;
      }

      // 搜索会话相关方法
      async createSearchSession(searchId, chatId, messageThreadId, query, results) {
        const resultsJson = JSON.stringify(results);
        await this.db.prepare(`
          INSERT INTO search_sessions (id, chat_id, message_thread_id, query, results, current_index, created_at)
          VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
        `).bind(searchId, chatId.toString(), messageThreadId ? messageThreadId.toString() : null, query, resultsJson, 0).run();
      }

      async getSearchSession(searchId) {
        const session = await this.db.prepare('SELECT * FROM search_sessions WHERE id = ?').bind(searchId).first();
        if (!session) return null;
        
        return {
          ...session,
          results: JSON.parse(session.results)
        };
      }

      async updateSearchSessionIndex(searchId, index) {
        await this.db.prepare(`
          UPDATE search_sessions 
          SET current_index = ?, updated_at = strftime('%s', 'now') 
          WHERE id = ?
        `).bind(index, searchId).run();
      }

      async cleanupExpiredSearchSessions(maxAgeMinutes = 30) {
        const maxAgeSeconds = maxAgeMinutes * 60;
        const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
        await this.db.prepare('DELETE FROM search_sessions WHERE created_at < ?').bind(cutoff).run();
      }
    }

    // ========== 配置服务类 ==========
    class ConfigService {
      constructor(db) {
        this.db = db;
      }

      async getSystemConfigs() {
        const { results } = await this.db.prepare('SELECT key, value FROM system_configs').all();
        const configs = {};
        results.forEach(row => configs[row.key] = row.value);
        return configs;
      }

      async updateSystemConfigs(configs) {
        for (const [key, value] of Object.entries(configs)) {
          await this.db.prepare(`
            INSERT OR REPLACE INTO system_configs (key, value, updated_at)
            VALUES (?, ?, strftime('%s', 'now'))
          `).bind(key, value.toString()).run();
        }
      }

      async getGroupConfigs() {
        const { results } = await this.db.prepare(`
          SELECT chat_id, chat_title, chat_type, enabled, allowed_thread_ids
          FROM group_configs
          ORDER BY updated_at DESC
        `).all();
        
        return results.map(g => ({
          chat_id: g.chat_id,
          chat_title: g.chat_title || '未知群组',
          chat_type: g.chat_type || 'group',
          enabled: g.enabled === 1,
          allowed_thread_ids: g.allowed_thread_ids || ''
        }));
      }

      async updateGroupConfig(chatId, { enabled, allowed_thread_ids }) {
        const existing = await this.db.prepare('SELECT chat_id FROM group_configs WHERE chat_id = ?').bind(chatId).first();
        
        if (existing) {
          await this.db.prepare(`
            UPDATE group_configs 
            SET enabled = ?, allowed_thread_ids = ?, updated_at = strftime('%s', 'now')
            WHERE chat_id = ?
          `).bind(enabled ? 1 : 0, allowed_thread_ids || '', chatId).run();
        } else {
          await this.db.prepare(`
            INSERT INTO group_configs (chat_id, chat_title, enabled, allowed_thread_ids, updated_at)
            VALUES (?, ?, ?, ?, strftime('%s', 'now'))
          `).bind(chatId, '未知群组', enabled ? 1 : 0, allowed_thread_ids || '').run();
        }
      }

      async getBotConfigs() {
        const configs = await this.getSystemConfigs();
        return {
          enableBotSearch: configs.enable_bot_search !== '0',
          botLanguage: configs.bot_language || 'zh'
        };
      }
    }

    // ========== Telegram服务类 ==========
    class TelegramService {
      constructor(botToken) {
        this.botToken = botToken;
        // 注意：搜索状态现在存储在数据库中，不再使用内存Map
      }

      // HTML转义函数
      escapeHtml(text) {
        if (!text) return '';
        return text
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      async setWebhook(webhookUrl, secret) {
        const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: secret,
            allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post', 'my_chat_member', 'callback_query']
          })
        });
        return await response.json();
      }

      async sendMessage(chatId, text, options = {}) {
        const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
        
        const body = {
          chat_id: chatId,
          text: text,
          parse_mode: options.parse_mode || 'HTML',
          disable_web_page_preview: options.disable_web_page_preview || true,
          reply_to_message_id: options.reply_to_message_id,
          reply_markup: options.reply_markup
        };
        
        if (options.message_thread_id) {
          body.message_thread_id = options.message_thread_id;
        }
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        
        return await response.json();
      }

      async deleteMessage(chatId, messageId) {
        try {
          const url = `https://api.telegram.org/bot${this.botToken}/deleteMessage`;
          
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              message_id: messageId
            })
          });
        } catch (error) {
          console.error('删除消息出错:', error);
        }
      }

      async editMessageText(chatId, messageId, text, options = {}) {
        const url = `https://api.telegram.org/bot${this.botToken}/editMessageText`;
        
        const body = {
          chat_id: chatId,
          message_id: messageId,
          text: text,
          parse_mode: options.parse_mode || 'HTML',
          disable_web_page_preview: options.disable_web_page_preview || true,
          reply_markup: options.reply_markup
        };
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        
        return await response.json();
      }

      async answerCallbackQuery(callbackQueryId, text = '', showAlert = false) {
        const url = `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`;
        
        const body = {
          callback_query_id: callbackQueryId
        };
        
        if (text) {
          body.text = text;
          body.show_alert = showAlert;
        }
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        
        return await response.json();
      }

      async setMyCommands() {
        const commands = [
          { command: 'start', description: '开始使用机器人' },
          { command: 'help', description: '查看帮助信息' },
          { command: 'search', description: '搜索方法代码' },
          { command: 'tags', description: '查看所有标签' },
          { command: 'tag', description: '按标签搜索方法' },
          { command: 'random', description: '随机获取方法' },
          { command: 'stats', description: '查看统计信息' }
        ];
        
        const url = `https://api.telegram.org/bot${this.botToken}/setMyCommands`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commands })
        });
        
        const result = await response.json();
        console.log('设置命令结果:', result);
        
        return result;
      }

      async getBotInfo() {
        const response = await fetch(`https://api.telegram.org/bot${this.botToken}/getMe`);
        return await response.json();
      }

      // 创建搜索结果的导航键盘
      createSearchKeyboard(totalResults, currentIndex, searchId = '') {
        const buttons = [];
        
        if (totalResults > 1) {
          const row = [];
          
          if (currentIndex > 0) {
            row.push({ text: '◀️ 上一个', callback_data: `search_prev_${currentIndex}_${searchId}` });
          }
          
          if (currentIndex < totalResults - 1) {
            row.push({ text: '下一个 ▶️', callback_data: `search_next_${currentIndex}_${searchId}` });
          }
          
          if (row.length > 0) {
            buttons.push(row);
          }
          
          // 添加"查看全部"按钮
          buttons.push([{ text: '📋 查看全部结果', callback_data: `search_view_all_${currentIndex}_${searchId}` }]);
        }
        
        if (buttons.length === 0) return null;
        
        return {
          inline_keyboard: buttons
        };
      }

      async handleMessage(msg, dbService) {
        const messageText = msg.text || msg.caption || '';
        if (!messageText) return;
        
        const messageId = msg.message_id;
        const chat = msg.chat;
        const author = getAuthor(msg);
        const codeBlocks = extractCodeBlocksFromMessage(msg, messageText);
        if (codeBlocks.length === 0) return;
        
        if (chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
          const chatIdStr = chat.id.toString();
          const config = await dbService.db.prepare('SELECT enabled, allowed_thread_ids FROM group_configs WHERE chat_id = ?').bind(chatIdStr).first();
          
          if (config) {
            const shouldProcess = config.enabled === 1;
            if (shouldProcess && config.allowed_thread_ids && config.allowed_thread_ids.trim() !== '') {
              const allowedThreadIds = config.allowed_thread_ids.split(',')
                .map(id => id.trim())
                .filter(id => id);
              
              if (allowedThreadIds.length > 0) {
                const currentThreadId = msg.message_thread_id?.toString() || '';
                if (!allowedThreadIds.includes(currentThreadId)) return;
              }
            }
            if (!shouldProcess) return;
          }
        }
        
        for (const block of codeBlocks) {
          const chatIdStr = chat?.id?.toString() || 'unknown';
          const hash = await sha256(block.code);
          
          const existing = await dbService.db.prepare('SELECT id FROM methods WHERE hash = ?').bind(hash).first();
          if (existing) continue;
          
          let link = '';
          if (chat && (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
            link = generateTelegramLink(chat, messageId);
          }
          
          await dbService.db.prepare(`
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

      async handleCommand(msg, dbService, configService) {
        const chatId = msg.chat.id;
        const messageText = msg.text || '';
        const from = msg.from;
        const messageThreadId = msg.message_thread_id;
        
        // 检查是否启用机器人搜索功能
        const botConfigs = await configService.getBotConfigs();
        if (!botConfigs.enableBotSearch) {
          await this.sendMessage(chatId, '❌ 机器人搜索功能已禁用。请联系管理员启用。', {
            message_thread_id: messageThreadId
          });
          return;
        }
        
        // 提取命令和参数
        const match = messageText.match(/^\/(\w+)(?:\s+(.+))?$/);
        if (!match) return false;
        
        const command = match[1].toLowerCase();
        const args = match[2] || '';
        
        console.log(`收到命令: /${command}, 参数: ${args}, 来自: ${chatId}, 线程ID: ${messageThreadId}`);
        
        try {
          switch (command) {
            case 'start':
            case 'help':
              return await this.sendHelpMessage(chatId, dbService, messageThreadId);
              
            case 'search':
              return await this.handleSearchCommand(chatId, args, dbService, messageThreadId);
              
            case 'tags':
              return await this.handleTagsCommand(chatId, dbService, messageThreadId);
              
            case 'tag':
              return await this.handleTagSearchCommand(chatId, args, dbService, messageThreadId);
              
            case 'random':
              return await this.handleRandomCommand(chatId, dbService, messageThreadId);
              
            case 'stats':
              return await this.handleStatsCommand(chatId, dbService, messageThreadId);
              
            default:
              return await this.sendMessage(chatId, '❓ 未知命令。使用 /help 查看可用命令。', {
                message_thread_id: messageThreadId
              });
          }
        } catch (error) {
          console.error('处理命令时出错:', error);
          return await this.sendMessage(chatId, '❌ 处理命令时出现错误，请稍后重试。', {
            message_thread_id: messageThreadId
          });
        }
      }

      async sendHelpMessage(chatId, dbService, messageThreadId = null) {
        const methodCount = await dbService.getMethodCount();
        
        const helpText = `🤖 <b>ShortX 方法搜索机器人</b>

📚 <b>可用命令:</b>
/search [关键词] - 搜索方法（标题/代码/标签）
/tags - 查看所有标签
/tag [标签名] - 按标签搜索方法
/random - 随机获取一个已验证方法
/stats - 查看统计信息
/help - 显示此帮助信息

📝 <b>使用示例:</b>
/search JavaScript 函数
/tag MVEL
/tag Java

🔍 <b>高级搜索:</b>
• 多个关键词用空格分隔
• 使用引号搜索完整短语
• 组合标签和关键词搜索

📊 数据库当前包含 <b>${methodCount}</b> 个方法。`;

        return await this.sendMessage(chatId, helpText, { 
          parse_mode: 'HTML',
          message_thread_id: messageThreadId
        });
      }

      async handleSearchCommand(chatId, query, dbService, messageThreadId = null) {
        if (!query.trim()) {
          return await this.sendMessage(chatId, '❌ 请输入搜索关键词。例如：<code>/search JavaScript</code>', {
            message_thread_id: messageThreadId,
            parse_mode: 'HTML'
          });
        }
        
        try {
          // 直接搜索，不发送"正在搜索"提示
          const methods = await dbService.searchMethodsForBot(query.trim(), 10);
          
          if (methods.length === 0) {
            return await this.sendMessage(chatId, `❌ 未找到包含 "<b>${this.escapeHtml(query)}</b>" 的方法。`, {
              message_thread_id: messageThreadId,
              parse_mode: 'HTML'
            });
          }
          
          // 生成搜索ID
          const searchId = Date.now().toString(36) + Math.random().toString(36).substr(2);
          
          // 保存搜索状态到数据库
          await dbService.createSearchSession(searchId, chatId, messageThreadId, query.trim(), methods);
          
          // 发送第一条结果
          const currentMethod = methods[0];
          const keyboard = this.createSearchKeyboard(methods.length, 0, searchId);
          
          const message = this.formatMethodForTelegram(currentMethod, false);
          
          return await this.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            message_thread_id: messageThreadId,
            reply_markup: keyboard
          });
          
        } catch (error) {
          console.error('搜索出错:', error);
          return await this.sendMessage(chatId, '❌ 搜索过程中出现错误。', {
            message_thread_id: messageThreadId
          });
        }
      }

      async handleCallbackQuery(callbackQuery, dbService, configService) {
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        const callbackData = callbackQuery.data;
        const callbackQueryId = callbackQuery.id;
        const messageThreadId = callbackQuery.message.message_thread_id;
        
        try {
          // 解析回调数据
          const parts = callbackData.split('_');
          const action = parts[1];
          
          if (action === 'prev' || action === 'next' || action === 'view_all') {
            const currentIndex = parseInt(parts[2]);
            const searchId = parts[3];
            
            // 从数据库获取搜索状态
            const searchState = await dbService.getSearchSession(searchId);
            
            if (!searchState) {
              await this.answerCallbackQuery(callbackQueryId, '搜索会话已过期，请重新搜索。', true);
              return;
            }
            
            // 清理过期的搜索状态（超过30分钟）
            await dbService.cleanupExpiredSearchSessions(30);
            
            if (action === 'prev' || action === 'next') {
              let newIndex = currentIndex;
              
              if (action === 'prev' && currentIndex > 0) {
                newIndex = currentIndex - 1;
              } else if (action === 'next' && currentIndex < searchState.results.length - 1) {
                newIndex = currentIndex + 1;
              }
              
              // 更新数据库中的当前索引
              await dbService.updateSearchSessionIndex(searchId, newIndex);
              
              // 更新消息内容
              const newMethod = searchState.results[newIndex];
              const message = this.formatMethodForTelegram(newMethod, false);
              const keyboard = this.createSearchKeyboard(searchState.results.length, newIndex, searchId);
              
              await this.editMessageText(chatId, messageId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: keyboard
              });
              
              await this.answerCallbackQuery(callbackQueryId);
              
            } else if (action === 'view_all') {
              // 立即回答回调查询
              await this.answerCallbackQuery(callbackQueryId, '开始发送所有结果...', false);
              
              // 异步发送所有结果（逐个发送）
              await this.sendAllSearchResults(chatId, searchState, messageThreadId);
            }
          }
        } catch (error) {
          console.error('处理回调查询出错:', error);
          await this.answerCallbackQuery(callbackQueryId, '操作失败，请重试。', true);
        }
      }

      async sendAllSearchResults(chatId, searchState, messageThreadId = null) {
        const { query, results } = searchState;
        
        // 先发送一条提示消息
        await this.sendMessage(chatId, `📋 开始发送全部搜索结果（共 ${results.length} 个方法）...`, {
          message_thread_id: messageThreadId,
          parse_mode: 'HTML'
        });
        
        // 逐个发送每个方法，添加延迟避免被限制
        for (let i = 0; i < results.length; i++) {
          const method = results[i];
          const message = this.formatMethodForTelegram(method, false);
          
          // 发送消息
          await this.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            message_thread_id: messageThreadId
          });
          
          // 如果不是最后一个方法，添加延迟
          if (i < results.length - 1) {
            // 每发送3条消息，增加一点延迟
            if ((i + 1) % 3 === 0) {
              await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒延迟
            } else {
              await new Promise(resolve => setTimeout(resolve, 1000)); // 1秒延迟
            }
          }
        }
        
        // 发送完成消息
        await this.sendMessage(chatId, `✅ 全部 ${results.length} 个方法已发送完成！`, {
          message_thread_id: messageThreadId,
          parse_mode: 'HTML'
        });
      }

      async sendSearchSummary(chatId, searchState, messageThreadId = null) {
        const { query, results } = searchState;
        
        let summary = `🔍 搜索 "<b>${this.escapeHtml(query)}</b>" 结果汇总：\n\n`;
        
        results.forEach((method, index) => {
          const tags = method.tags && method.tags.length > 0 
            ? method.tags.map(tag => `<code>#${this.escapeHtml(tag)}</code>`).join(' ') 
            : '无标签';
          
          summary += `<b>${index + 1}. ${this.escapeHtml(method.title)}</b>\n`;
          summary += `   标签: ${tags}\n`;
          summary += `   作者: ${this.escapeHtml(method.author || 'anonymous')}\n`;
          summary += `   状态: ${method.verified ? '✅ 已验证' : '❌ 未验证'}\n\n`;
        });
        
        summary += `📊 共找到 <b>${results.length}</b> 个方法\n`;
        summary += `💡 使用搜索结果的导航按钮查看每个方法的详细信息`;
        
        await this.sendMessage(chatId, summary, {
          parse_mode: 'HTML',
          message_thread_id: messageThreadId
        });
      }

      async handleTagsCommand(chatId, dbService, messageThreadId = null) {
        try {
          const tags = await dbService.getTags();
          
          if (tags.length === 0) {
            return await this.sendMessage(chatId, '📭 暂无标签。', {
              message_thread_id: messageThreadId
            });
          }
          
          // 分组显示标签，每行4个
          const chunkSize = 4;
          let tagLines = [];
          for (let i = 0; i < tags.length; i += chunkSize) {
            const chunk = tags.slice(i, i + chunkSize);
            tagLines.push(chunk.map(tag => `<code>#${this.escapeHtml(tag)}</code>`).join('  '));
          }
          
          const message = `🏷️ <b>可用标签</b> (共 ${tags.length} 个):\n\n${tagLines.join('\n')}\n\n使用 <code>/tag [标签名]</code> 查看具体方法`;
          
          return await this.sendMessage(chatId, message, { 
            parse_mode: 'HTML',
            message_thread_id: messageThreadId
          });
          
        } catch (error) {
          console.error('获取标签出错:', error);
          return await this.sendMessage(chatId, '❌ 获取标签时出现错误。', {
            message_thread_id: messageThreadId
          });
        }
      }

      async handleTagSearchCommand(chatId, tag, dbService, messageThreadId = null) {
        if (!tag.trim()) {
          return await this.sendMessage(chatId, '❌ 请输入标签名称。例如：<code>/tag JavaScript</code>', {
            message_thread_id: messageThreadId,
            parse_mode: 'HTML'
          });
        }
        
        try {
          const methods = await dbService.getMethodsByTag(tag.trim(), 10);
          
          if (methods.length === 0) {
            return await this.sendMessage(chatId, `❌ 未找到标签为 "<b>#${this.escapeHtml(tag)}</b>" 的方法。`, {
              message_thread_id: messageThreadId,
              parse_mode: 'HTML'
            });
          }
          
          // 生成搜索ID
          const searchId = Date.now().toString(36) + Math.random().toString(36).substr(2);
          
          // 保存搜索状态到数据库
          await dbService.createSearchSession(searchId, chatId, messageThreadId, `#${tag.trim()}`, methods);
          
          // 发送第一条结果
          const currentMethod = methods[0];
          const keyboard = this.createSearchKeyboard(methods.length, 0, searchId);
          
          const message = this.formatMethodForTelegram(currentMethod, false);
          
          return await this.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            message_thread_id: messageThreadId,
            reply_markup: keyboard
          });
          
        } catch (error) {
          console.error('标签搜索出错:', error);
          return await this.sendMessage(chatId, '❌ 搜索标签时出现错误。', {
            message_thread_id: messageThreadId
          });
        }
      }

      async handleRandomCommand(chatId, dbService, messageThreadId = null) {
        try {
          // 增加重试机制
          let retryCount = 0;
          const maxRetries = 3;
          let method = null;
          
          while (retryCount < maxRetries && !method) {
            try {
              method = await dbService.getRandomMethod();
              if (method) break;
            } catch (error) {
              console.error(`获取随机方法失败 (尝试 ${retryCount + 1}/${maxRetries}):`, error);
              retryCount++;
              if (retryCount < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }
          }
          
          if (!method) {
            return await this.sendMessage(chatId, '📭 当前没有可用的方法。请尝试添加一些方法。', {
              message_thread_id: messageThreadId
            });
          }
          
          // 格式化消息并发送
          const message = this.formatMethodForTelegram(method, true);
          
          return await this.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            message_thread_id: messageThreadId
          });
          
        } catch (error) {
          console.error('获取随机方法出错:', error);
          return await this.sendMessage(chatId, '❌ 获取随机方法时出现错误，请稍后重试。', {
            message_thread_id: messageThreadId
          });
        }
      }

      async handleStatsCommand(chatId, dbService, messageThreadId = null) {
        try {
          const stats = await dbService.getStats();
          const methodCount = await dbService.getMethodCount();
          
          const verifiedPercentage = methodCount > 0 ? Math.round((stats.verified / methodCount) * 100) : 0;
          
          let topTagsText = '';
          if (stats.tagCounts && Object.keys(stats.tagCounts).length > 0) {
            const topTags = Object.entries(stats.tagCounts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5);
            
            topTagsText = '<b>热门标签:</b>\n';
            topTags.forEach(([tag, count], index) => {
              topTagsText += `${index + 1}. <code>#${this.escapeHtml(tag)}</code> (${count})\n`;
            });
          }
          
          const message = `📊 <b>方法库统计信息</b>\n
📁 总方法数: <b>${methodCount}</b>
✅ 已验证方法: <b>${stats.verified}</b>
🏷️ 标签种类: <b>${stats.tags}</b>
📈 验证比例: <b>${verifiedPercentage}%</b>\n
${topTagsText}
💡 使用 /search 或 /tag 命令搜索方法。`;
          
          return await this.sendMessage(chatId, message, { 
            parse_mode: 'HTML',
            message_thread_id: messageThreadId
          });
          
        } catch (error) {
          console.error('获取统计信息出错:', error);
          return await this.sendMessage(chatId, '❌ 获取统计信息时出现错误。', {
            message_thread_id: messageThreadId
          });
        }
      }

      formatMethodForTelegram(method, isRandom = false) {
        const tags = method.tags && method.tags.length > 0 
          ? method.tags.map(tag => `<code>#${this.escapeHtml(tag)}</code>`).join(' ') 
          : '无标签';
        
        const verifiedBadge = method.verified ? ' ✅' : '';
        const author = this.escapeHtml(method.author || 'anonymous');
        
        // 格式化时间戳
        const date = method.created_at ? new Date(method.created_at * 1000).toLocaleDateString('zh-CN') : '未知时间';
        
        let linkText = '';
        if (method.link) {
          linkText = `🔗 <a href="${this.escapeHtml(method.link)}">查看来源</a>`;
        }
        
        // 使用HTML格式，确保代码块正确显示
        let message = '';
        
        if (isRandom) {
          message += `<b>🎲 随机方法</b>\n\n`;
        }
        
        message += `<b>${this.escapeHtml(method.title)}</b>${verifiedBadge}\n\n`;
        message += `👤 ${author}\n`;
        message += `📅 ${date}\n`;
        message += `🏷️ ${tags}\n\n`;
        
        // 确定代码语言
        let codeLanguage = '';
        if (method.title.includes('JavaScript') || method.title.includes('JS')) {
          codeLanguage = 'javascript';
        } else if (method.title.includes('Python')) {
          codeLanguage = 'python';
        } else if (method.title.includes('Java')) {
          codeLanguage = 'java';
        } else if (method.title.includes('MVEL')) {
          codeLanguage = 'java';
        } else if (method.title.includes('PHP')) {
          codeLanguage = 'php';
        } else if (method.title.includes('HTML')) {
          codeLanguage = 'html';
        } else if (method.title.includes('CSS')) {
          codeLanguage = 'css';
        } else if (method.title.includes('SQL')) {
          codeLanguage = 'sql';
        }
        
        // 构建代码块 - 使用<pre><code>标签确保格式
        const maxLength = 3500;
        let codeToSend = this.escapeHtml(method.code);
        let truncated = false;
        
        if (codeToSend.length > maxLength) {
          codeToSend = codeToSend.substring(0, maxLength) + '\n\n... (代码过长，已截断)';
          truncated = true;
        }
        
        // 添加代码块 - Telegram支持HTML格式的<pre><code>
        if (codeLanguage) {
          message += `<pre><code class="language-${codeLanguage}">${codeToSend}</code></pre>\n\n`;
        } else {
          message += `<pre><code>${codeToSend}</code></pre>\n\n`;
        }
        
        if (truncated) {
          message += `<i>⚠️ 注意: 代码过长已截断，完整代码请访问Web界面查看。</i>\n\n`;
        }
        
        if (linkText) {
          message += `${linkText}\n\n`;
        }
        
        message += `<i>💡 提示: 长按代码块选择"复制文本"可完整复制代码。</i>`;
        
        return message;
      }

      async processUpdate(update, dbService, configService) {
        // 检查是否是回调查询
        if (update.callback_query) {
          await this.handleCallbackQuery(update.callback_query, dbService, configService);
          return;
        }
        
        if (update.my_chat_member) {
          const member = update.my_chat_member;
          const chat = member.chat;
          const newStatus = member.new_chat_member.status;
          const oldStatus = member.old_chat_member.status;
          
          if (newStatus === 'administrator' && 
              (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel')) {
            const chatIdStr = chat.id.toString();
            const existing = await dbService.db.prepare('SELECT chat_id FROM group_configs WHERE chat_id = ?').bind(chatIdStr).first();
            
            if (!existing) {
              await dbService.db.prepare(`
                INSERT INTO group_configs (chat_id, chat_title, enabled, allowed_thread_ids, chat_type)
                VALUES (?, ?, 1, '', ?)
              `).bind(chatIdStr, chat.title || '未知群组', chat.type).run();
            } else {
              await dbService.db.prepare(`
                UPDATE group_configs 
                SET chat_title = ?, chat_type = ?, updated_at = strftime('%s', 'now')
                WHERE chat_id = ?
              `).bind(chat.title || '未知群组', chat.type, chatIdStr).run();
            }
          }
          
          if ((newStatus === 'left' || newStatus === 'kicked' || newStatus === 'member') && 
              (oldStatus === 'administrator')) {
            const chatIdStr = chat.id.toString();
            await dbService.db.prepare('DELETE FROM group_configs WHERE chat_id = ?').bind(chatIdStr).run();
            await dbService.db.prepare('DELETE FROM methods WHERE chat_id = ?').bind(chatIdStr).run();
          }
          
          return;
        }
        
        const msg = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
        if (!msg) return;
        
        const messageText = msg.text || msg.caption || '';
        
        // 检查是否是命令
        if (messageText.startsWith('/')) {
          // 处理命令
          await this.handleCommand(msg, dbService, configService);
          return;
        }
        
        // 原有消息处理逻辑
        await this.handleMessage(msg, dbService);
      }

      async validateGroups(configService) {
        const { results } = await configService.db.prepare('SELECT chat_id FROM group_configs').all();
        
        let removed = 0;
        let validated = 0;
        
        const meResponse = await fetch('https://api.telegram.org/bot' + this.botToken + '/getMe');
        const meData = await meResponse.json();
        const botId = meData.result.id;
        
        for (const group of results) {
          try {
            const chatResponse = await fetch('https://api.telegram.org/bot' + this.botToken + '/getChat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: group.chat_id })
            });
            
            const chatData = await chatResponse.json();
            
            if (!chatData.ok) {
              await configService.db.prepare('DELETE FROM group_configs WHERE chat_id = ?').bind(group.chat_id).run();
              await configService.db.prepare('DELETE FROM methods WHERE chat_id = ?').bind(group.chat_id).run();
              removed++;
              continue;
            }
            
            const memberResponse = await fetch('https://api.telegram.org/bot' + this.botToken + '/getChatMember', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: group.chat_id,
                user_id: botId
              })
            });
            
            const memberData = await memberResponse.json();
            
            if (!memberData.ok || !memberData.result || memberData.result.status !== 'administrator') {
              await configService.db.prepare('DELETE FROM group_configs WHERE chat_id = ?').bind(group.chat_id).run();
              await configService.db.prepare('DELETE FROM methods WHERE chat_id = ?').bind(group.chat_id).run();
              removed++;
            } else {
              const chatInfo = chatData.result;
              await configService.db.prepare(`
                UPDATE group_configs 
                SET chat_title = ?, chat_type = ?, updated_at = strftime('%s', 'now')
                WHERE chat_id = ?
              `).bind(chatInfo.title || '未知群组', chatInfo.type, group.chat_id).run();
              validated++;
            }
          } catch (e) {
            await configService.db.prepare('DELETE FROM group_configs WHERE chat_id = ?').bind(group.chat_id).run();
            await configService.db.prepare('DELETE FROM methods WHERE chat_id = ?').bind(group.chat_id).run();
            removed++;
          }
        }
        
        return { validated, removed, message: `验证完成：${validated} 个有效群组，${removed} 个失效群组已清理` };
      }

      async fetchSpecificMessages({ chat_id, message_ids, message_thread_id }, configService, dbService) {
        if (!chat_id || !message_ids) throw new Error('缺少必要参数');
        
        const configs = await configService.getSystemConfigs();
        const forwardMethod = configs.forward_method || 'in_situ';
        const forwardApi = configs.forward_api || 'forwardMessage';
        const autoDelete = configs.auto_delete !== '0';
        
        let targetChatId;
        let targetThreadId = null;
        
        switch (forwardMethod) {
          case 'admin':
            targetChatId = configs.admin_user_id;
            if (!targetChatId) throw new Error('未设置管理员用户ID');
            break;
          case 'custom':
            targetChatId = configs.forward_target;
            if (!targetChatId) throw new Error('未设置转发目标');
            if (configs.forward_thread_id && configs.forward_thread_id.trim() !== '') {
              targetThreadId = parseInt(configs.forward_thread_id.trim());
              if (isNaN(targetThreadId)) targetThreadId = null;
            }
            break;
          case 'in_situ':
          default:
            targetChatId = chat_id;
            if (message_thread_id) targetThreadId = message_thread_id;
            break;
        }
        
        const messageIdArray = Array.isArray(message_ids) ? message_ids : 
                             message_ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
        
        let processed = 0;
        let failed = 0;
        const failedMessages = [];
        
        for (const message_id of messageIdArray) {
          try {
            const forwardBody = {
              chat_id: targetChatId,
              from_chat_id: chat_id,
              message_id: message_id,
              disable_notification: true
            };
            
            if (targetThreadId) forwardBody.message_thread_id = targetThreadId;
            
            let forwardResponse;
            let forwardedMsg;
            let originalChatId = chat_id;
            let originalMessageId = message_id;
            
            if (forwardApi === 'copyMessage') {
              forwardResponse = await fetch(`https://api.telegram.org/bot${this.botToken}/copyMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(forwardBody)
              });
              
              const copyData = await forwardResponse.json();
              if (!copyData.ok) throw new Error(copyData.description);
              forwardedMsg = copyData.result;
            } else {
              forwardResponse = await fetch(`https://api.telegram.org/bot${this.botToken}/forwardMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(forwardBody)
              });
              
              const forwardData = await forwardResponse.json();
              if (!forwardData.ok) throw new Error(forwardData.description);
              forwardedMsg = forwardData.result;
              
              if (forwardedMsg.forward_from_chat) {
                originalChatId = forwardedMsg.forward_from_chat.id;
                originalMessageId = forwardedMsg.forward_from_message_id || message_id;
              } else if (forwardedMsg.forward_from) {
                originalChatId = forwardedMsg.forward_from.id;
                originalMessageId = forwardedMsg.forward_from_message_id || message_id;
              }
            }
            
            const messageText = forwardedMsg.text || forwardedMsg.caption || '';
            if (!messageText) throw new Error('消息无文本内容');
            
            const codeBlocks = extractCodeBlocksFromMessage(forwardedMsg, messageText);
            if (codeBlocks.length === 0) throw new Error('消息无代码块');
            
            for (const block of codeBlocks) {
              const hash = await sha256(block.code);
              const existing = await dbService.db.prepare('SELECT id FROM methods WHERE hash = ?').bind(hash).first();
              if (existing) continue;
              
              const author = getAuthor(forwardedMsg);
              let link = '';
              
              if (forwardApi === 'forwardMessage') {
                if (forwardedMsg.forward_from_chat) {
                  const originalChat = forwardedMsg.forward_from_chat;
                  link = generateTelegramLink(originalChat, originalMessageId);
                } else {
                  link = generateTelegramLinkFromId(originalChatId, originalMessageId);
                }
              } else {
                link = generateTelegramLinkFromId(originalChatId, originalMessageId);
              }
              
              await dbService.db.prepare(`
                INSERT INTO methods (title, code, tags, author, source, chat_id, message_id, link, hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                block.title,
                block.code,
                block.tags.join(','),
                author,
                'telegram_forward',
                originalChatId.toString(),
                originalMessageId,
                link,
                hash
              ).run();
              
              processed++;
            }
            
            if (autoDelete) {
              try {
                await fetch(`https://api.telegram.org/bot${this.botToken}/deleteMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: targetChatId,
                    message_id: forwardedMsg.message_id
                  })
                });
              } catch (e) {
                console.error('删除消息异常:', e);
              }
            }
            
          } catch (error) {
            console.error(`处理消息 ${message_id} 失败:`, error);
            failed++;
            failedMessages.push({ message_id, error: error.message });
          }
          
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        return {
          processed,
          failed,
          failed_messages: failedMessages,
          message: `处理完成：成功 ${processed} 条，失败 ${failed} 条`
        };
      }
    }

    // ========== 路由处理器 ==========
    const ADMIN_KEY = env.ADMIN_KEY || "admin123";
    const BOT_TOKEN = env.BOT_TOKEN;
    const WEBHOOK_SECRET = env.WEBHOOK_SECRET || "webhook_secret";
    const DB = env.SHORTX_DB;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(getHTMLPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    if (url.pathname === '/init-db' && request.method === 'POST') {
      if (!DB) return errorResponse('未绑定 D1 数据库', 500);
      
      try {
        const dbService = new DatabaseService(DB);
        await dbService.initializeDatabase();
        return jsonResponse({ success: true, message: '数据库初始化成功' });
      } catch (error) {
        return errorResponse('数据库操作失败', 500, error);
      }
    }

    if (url.pathname === '/set-webhook' && request.method === 'POST') {
      if (!BOT_TOKEN) return errorResponse('未设置 BOT_TOKEN', 500);
      
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      const telegramService = new TelegramService(BOT_TOKEN);
      const webhookUrl = `${url.origin}/webhook`;
      
      try {
        // 设置 Webhook
        const webhookResult = await telegramService.setWebhook(webhookUrl, WEBHOOK_SECRET);
        
        // 设置 Bot 命令
        const commandsResult = await telegramService.setMyCommands();
        
        // 获取 Bot 信息
        const botInfo = await telegramService.getBotInfo();
        
        return jsonResponse({
          success: true,
          webhook: webhookResult,
          commands: commandsResult,
          bot_info: botInfo,
          message: 'Webhook 和命令设置完成'
        });
      } catch (error) {
        return errorResponse('设置失败', 500, error);
      }
    }

    if (url.pathname === '/webhook' && request.method === 'POST') {
      const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (secret && secret !== WEBHOOK_SECRET) {
        return errorResponse('无效的 webhook secret', 403);
      }
      
      try {
        const update = await request.json();
        const telegramService = new TelegramService(BOT_TOKEN);
        const dbService = new DatabaseService(DB);
        const configService = new ConfigService(DB);
        
        await telegramService.processUpdate(update, dbService, configService);
        return new Response('OK', { status: 200 });
      } catch (error) {
        console.error('Webhook error:', error);
        return new Response('OK', { status: 200 });
      }
    }

    if (url.pathname === '/api/system-configs' && request.method === 'GET') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      try {
        const configService = new ConfigService(DB);
        const configs = await configService.getSystemConfigs();
        return jsonResponse({ success: true, configs });
      } catch (error) {
        return errorResponse('查询失败', 500, error);
      }
    }

    if (url.pathname === '/api/system-configs' && request.method === 'PUT') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      try {
        const configs = await request.json();
        const configService = new ConfigService(DB);
        await configService.updateSystemConfigs(configs);
        return jsonResponse({ success: true });
      } catch (error) {
        return errorResponse('更新失败', 500, error);
      }
    }

    if (url.pathname === '/api/group-configs' && request.method === 'GET') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      try {
        const configService = new ConfigService(DB);
        const groups = await configService.getGroupConfigs();
        return jsonResponse({ success: true, groups });
      } catch (error) {
        return errorResponse('查询失败', 500, error);
      }
    }

    if (url.pathname.startsWith('/api/group-configs/') && request.method === 'PUT') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      const pathParts = url.pathname.split('/');
      const chatId = pathParts[pathParts.length - 1];
      
      try {
        const { enabled, allowed_thread_ids } = await request.json();
        const configService = new ConfigService(DB);
        await configService.updateGroupConfig(chatId, { enabled, allowed_thread_ids });
        return jsonResponse({ success: true });
      } catch (error) {
        return errorResponse('更新失败', 500, error);
      }
    }

    if (url.pathname === '/api/group-configs/validate' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      if (!BOT_TOKEN) return errorResponse('未设置 BOT_TOKEN', 500);
      
      try {
        const telegramService = new TelegramService(BOT_TOKEN);
        const configService = new ConfigService(DB);
        const result = await telegramService.validateGroups(configService);
        return jsonResponse({ success: true, ...result });
      } catch (error) {
        return errorResponse('验证失败', 500, error);
      }
    }

    if (url.pathname === '/api/fetch-specific-messages' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      if (!BOT_TOKEN) return errorResponse('未设置 BOT_TOKEN', 500);
      
      try {
        const data = await request.json();
        const telegramService = new TelegramService(BOT_TOKEN);
        const configService = new ConfigService(DB);
        const dbService = new DatabaseService(DB);
        
        const result = await telegramService.fetchSpecificMessages(data, configService, dbService);
        return jsonResponse({ success: true, ...result });
      } catch (error) {
        return errorResponse('处理失败', 500, error);
      }
    }

    if (url.pathname === '/api/methods' && request.method === 'GET') {
      const query = url.searchParams.get('q') || '';
      const tag = url.searchParams.get('tag') || '';
      const verified = url.searchParams.get('verified');
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      
      const dbService = new DatabaseService(DB);
      try {
        const { methods, total } = await dbService.getMethods({ query, tag, verified, limit, offset });
        return jsonResponse({ success: true, methods, total, limit, offset });
      } catch (error) {
        return errorResponse('查询失败', 500, error);
      }
    }

    if (url.pathname.match(/^\/api\/methods\/\d+$/) && request.method === 'GET') {
      const id = url.pathname.split('/').pop();
      const dbService = new DatabaseService(DB);
      
      try {
        const method = await dbService.getMethodById(id);
        if (!method) return errorResponse('方法不存在', 404);
        return jsonResponse({ success: true, method });
      } catch (error) {
        return errorResponse('查询失败', 500, error);
      }
    }

    if (url.pathname === '/api/methods' && request.method === 'POST') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      try {
        const data = await request.json();
        const dbService = new DatabaseService(DB);
        const result = await dbService.createMethod(data);
        return jsonResponse({ success: true, id: result.id });
      } catch (error) {
        if (error.code === 'EXISTS') {
          return jsonResponse({ error: '方法已存在', id: error.id }, 409);
        }
        return errorResponse('添加失败', 500, error);
      }
    }

    if (url.pathname.match(/^\/api\/methods\/\d+$/) && request.method === 'PUT') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      const id = url.pathname.split('/').pop();
      
      try {
        const data = await request.json();
        const dbService = new DatabaseService(DB);
        await dbService.updateMethod(id, data);
        return jsonResponse({ success: true });
      } catch (error) {
        return errorResponse('更新失败', 500, error);
      }
    }

    if (url.pathname.match(/^\/api\/methods\/\d+$/) && request.method === 'DELETE') {
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      const id = url.pathname.split('/').pop();
      
      try {
        const dbService = new DatabaseService(DB);
        await dbService.deleteMethod(id);
        return jsonResponse({ success: true });
      } catch (error) {
        return errorResponse('删除失败', 500, error);
      }
    }

    if (url.pathname === '/api/export' && request.method === 'GET') {
      try {
        const dbService = new DatabaseService(DB);
        const methods = await dbService.exportMethods();
        return new Response(JSON.stringify(methods, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': 'attachment; filename="methods.json"',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        return errorResponse('导出失败', 500, error);
      }
    }

    if (url.pathname === '/api/shortx/methods.json') {
      try {
        const dbService = new DatabaseService(DB);
        const configService = new ConfigService(DB);
        const configs = await configService.getSystemConfigs();
        const methods = await dbService.getMethodsForShortX(configs);
        
        return new Response(JSON.stringify(methods, null, 2), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        return errorResponse('导出失败', 500, error);
      }
    }

    if (url.pathname === '/api/stats' && request.method === 'GET') {
      try {
        const dbService = new DatabaseService(DB);
        const stats = await dbService.getStats();
        return jsonResponse({ success: true, stats });
      } catch (error) {
        return errorResponse('统计失败', 500, error);
      }
    }

    if (url.pathname === '/api/tags' && request.method === 'GET') {
      try {
        const dbService = new DatabaseService(DB);
        const tags = await dbService.getTags();
        return jsonResponse({ success: true, tags });
      } catch (error) {
        return errorResponse('查询失败', 500, error);
      }
    }

    // 新添加的API端点：设置Bot命令
    if (url.pathname === '/api/set-commands' && request.method === 'POST') {
      if (!BOT_TOKEN) return errorResponse('未设置 BOT_TOKEN', 500);
      
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      const telegramService = new TelegramService(BOT_TOKEN);
      
      try {
        const result = await telegramService.setMyCommands();
        return jsonResponse({ success: true, result });
      } catch (error) {
        return errorResponse('设置命令失败', 500, error);
      }
    }

    // 新添加的API端点：获取Bot信息
    if (url.pathname === '/api/bot-info' && request.method === 'GET') {
      if (!BOT_TOKEN) return errorResponse('未设置 BOT_TOKEN', 500);
      
      const adminKey = request.headers.get('X-Admin-Key');
      if (adminKey !== ADMIN_KEY) return errorResponse('需要管理员权限', 403);
      
      const telegramService = new TelegramService(BOT_TOKEN);
      
      try {
        const result = await telegramService.getBotInfo();
        return jsonResponse({ success: true, bot: result });
      } catch (error) {
        return errorResponse('获取Bot信息失败', 500, error);
      }
    }

    return errorResponse('未找到路径', 404);
  }
};

// ========== 前端页面函数 ==========
function getHTMLPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ShortX Method Hub</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
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
    .config-card {
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    .config-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 20px rgba(0,0,0,0.1);
    }
    .forward-option {
      transition: all 0.3s ease;
    }
    .forward-option.active {
      border-color: #8b5cf6;
      background-color: #f5f3ff;
    }
    .bot-command {
      font-family: 'Courier New', monospace;
      background-color: #f3f4f6;
      padding: 2px 6px;
      border-radius: 4px;
      color: #8b5cf6;
      font-weight: 600;
    }
  </style>
</head>
<body class="bg-gradient-to-br from-blue-50 to-purple-50 min-h-screen">
  <div id="app" class="max-w-7xl mx-auto"></div>
  <div id="toast">操作成功！</div>
  
  <script>
    class ShortXApp {
      constructor() {
        this.API_BASE = location.origin;
        this.ADMIN_KEY = localStorage.getItem('admin_key') || '';
        this.state = {
          currentTab: 'search',
          methods: [],
          stats: {},
          groups: [],
          systemConfigs: {},
          searchQuery: '',
          selectedTag: '',
          selectedChatId: '',
          isSearching: false,
          isValidating: false,
          historyFetching: false,
          showModal: false,
          editing: null,
          showDeleteConfirm: false,
          deletingId: null,
          showLogoutConfirm: false,
          showHistoryModal: false,
          botInfo: null,
          botCommands: [],
          botTab: 'bot-commands'
        };
      }

      async init() {
        await Promise.all([
          this.loadMethods(),
          this.loadStats(),
          this.loadGroups(),
          this.loadSystemConfigs()
        ]);
        
        if (this.ADMIN_KEY) {
          await this.loadBotInfo();
        }
        
        this.render();
        this.bindEvents();
      }

      setState(newState) {
        this.state = { ...this.state, ...newState };
        this.render();
      }

      async loadMethods(q = '', tag = '') {
        this.setState({ isSearching: true });
        try {
          let url = \`\${this.API_BASE}/api/methods?limit=200\`;
          if (q) url += \`&q=\${encodeURIComponent(q)}\`;
          if (tag) url += \`&tag=\${encodeURIComponent(tag)}\`;
          
          const res = await fetch(url);
          const data = await res.json();
          this.setState({ methods: data.methods || [], isSearching: false });
        } catch (error) {
          console.error('加载方法失败:', error);
          this.setState({ isSearching: false });
        }
      }

      async loadStats() {
        try {
          const res = await fetch(\`\${this.API_BASE}/api/stats\`);
          const data = await res.json();
          this.setState({ stats: data.stats || {} });
        } catch (error) {
          console.error('加载统计失败:', error);
        }
      }

      async loadGroups() {
        if (!this.ADMIN_KEY) return;
        try {
          const res = await fetch(\`\${this.API_BASE}/api/group-configs\`, {
            headers: { 'X-Admin-Key': this.ADMIN_KEY }
          });
          const data = await res.json();
          this.setState({ groups: data.groups || [] });
        } catch (error) {
          console.error('加载群组配置失败', error);
        }
      }

      async loadSystemConfigs() {
        if (!this.ADMIN_KEY) return;
        try {
          const res = await fetch(\`\${this.API_BASE}/api/system-configs\`, {
            headers: { 'X-Admin-Key': this.ADMIN_KEY }
          });
          const data = await res.json();
          if (data.success) {
            this.setState({ systemConfigs: data.configs || {} });
          }
        } catch (error) {
          console.error('加载系统配置失败', error);
        }
      }

      async loadBotInfo() {
        try {
          const res = await fetch(\`\${this.API_BASE}/api/bot-info\`, {
            headers: { 'X-Admin-Key': this.ADMIN_KEY }
          });
          const data = await res.json();
          if (data.success) {
            this.setState({ botInfo: data.bot });
          }
        } catch (error) {
          console.error('加载Bot信息失败', error);
        }
      }

      async setBotCommands() {
        try {
          const res = await fetch(\`\${this.API_BASE}/api/set-commands\`, {
            method: 'POST',
            headers: { 'X-Admin-Key': this.ADMIN_KEY }
          });
          const data = await res.json();
          if (data.success) {
            this.showToast('Bot命令设置成功');
          } else {
            this.showToast(data.error || '设置失败', true);
          }
        } catch (error) {
          this.showToast('设置命令失败: ' + error.message, true);
        }
      }

      async saveSystemConfigs() {
        try {
          const res = await fetch(\`\${this.API_BASE}/api/system-configs\`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'X-Admin-Key': this.ADMIN_KEY
            },
            body: JSON.stringify(this.state.systemConfigs)
          });
          
          const data = await res.json();
          if (data.success) {
            this.showToast('系统配置保存成功');
          } else {
            this.showToast(data.error || '保存失败', true);
          }
        } catch (error) {
          this.showToast('保存失败: ' + error.message, true);
        }
      }

      async updateGroup(chatId, enabled, threadIds) {
        try {
          const res = await fetch(\`\${this.API_BASE}/api/group-configs/\${encodeURIComponent(chatId)}\`, {
            method: 'PUT',
            headers: { 
              'Content-Type': 'application/json', 
              'X-Admin-Key': this.ADMIN_KEY 
            },
            body: JSON.stringify({ 
              enabled: Boolean(enabled), 
              allowed_thread_ids: threadIds || '' 
            })
          });
          
          const data = await res.json();
          if (data.success) {
            this.showToast('配置保存成功');
            await this.loadGroups();
          } else {
            this.showToast(data.error || '保存失败', true);
          }
        } catch (e) {
          this.showToast('保存失败: ' + e.message, true);
        }
      }

      async validateGroups() {
        this.setState({ isValidating: true });
        try {
          const res = await fetch(\`\${this.API_BASE}/api/group-configs/validate\`, {
            method: 'POST',
            headers: { 'X-Admin-Key': this.ADMIN_KEY }
          });

          const data = await res.json();
          if (data.success) {
            this.showToast(data.message);
            await this.loadGroups();
          } else {
            this.showToast(data.error || '验证失败', true);
          }
        } catch (error) {
          this.showToast('验证失败: ' + error.message, true);
        } finally {
          this.setState({ isValidating: false });
        }
      }

      async fetchSpecificMessages(chatId, messageIds, threadId) {
        if (!chatId || !messageIds) {
          this.showToast('请输入必要的参数', true);
          return;
        }

        this.setState({ historyFetching: true });
        try {
          const body = {
            chat_id: chatId,
            message_ids: messageIds.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
          };
          
          if (threadId && !isNaN(parseInt(threadId))) {
            body.message_thread_id = parseInt(threadId);
          }
          
          const res = await fetch(\`\${this.API_BASE}/api/fetch-specific-messages\`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Admin-Key': this.ADMIN_KEY
            },
            body: JSON.stringify(body)
          });

          const data = await res.json();
          if (data.success) {
            this.showToast(data.message);
            this.setState({ showHistoryModal: false });
            await Promise.all([
              this.loadMethods(this.state.searchQuery, this.state.selectedTag), 
              this.loadStats()
            ]);
          } else {
            this.showToast(data.error || '处理失败', true);
          }
        } catch (error) {
          this.showToast('处理失败: ' + error.message, true);
        } finally {
          this.setState({ historyFetching: false });
        }
      }

      async saveMethod(methodData) {
        const url = methodData.id ? 
          \`\${this.API_BASE}/api/methods/\${methodData.id}\` : 
          \`\${this.API_BASE}/api/methods\`;
        
        try {
          const res = await fetch(url, { 
            method: methodData.id ? 'PUT' : 'POST',
            headers: { 
              'Content-Type': 'application/json', 
              'X-Admin-Key': this.ADMIN_KEY 
            }, 
            body: JSON.stringify(methodData) 
          });
          
          const data = await res.json();
          if (data.success || res.ok) {
            this.showToast(methodData.id ? '更新成功！' : '添加成功！');
            this.setState({ showModal: false, editing: null });
            await Promise.all([
              this.loadMethods(this.state.searchQuery, this.state.selectedTag), 
              this.loadStats()
            ]);
          } else {
            this.showToast(data.error || '操作失败', true);
          }
        } catch (error) {
          this.showToast('操作失败: ' + error.message, true);
        }
      }

      async verifyMethod(id, verified) {
        try {
          await fetch(\`\${this.API_BASE}/api/methods/\${id}\`, { 
            method: 'PUT', 
            headers: { 
              'Content-Type': 'application/json', 
              'X-Admin-Key': this.ADMIN_KEY 
            }, 
            body: JSON.stringify({ verified: !verified }) 
          });
          
          this.showToast(verified ? '已取消验证' : '已标记为验证');
          await Promise.all([
            this.loadMethods(this.state.searchQuery, this.state.selectedTag), 
            this.loadStats()
          ]);
        } catch (error) {
          this.showToast('操作失败', true);
        }
      }

      async deleteMethod(id) {
        try {
          await fetch(\`\${this.API_BASE}/api/methods/\${id}\`, { 
            method: 'DELETE', 
            headers: { 'X-Admin-Key': this.ADMIN_KEY } 
          });
          
          this.showToast('删除成功！');
          this.setState({ showDeleteConfirm: false, deletingId: null });
          await Promise.all([
            this.loadMethods(this.state.searchQuery, this.state.selectedTag), 
            this.loadStats()
          ]);
        } catch (error) {
          this.showToast('删除失败', true);
        }
      }

      login(password) {
        if (!password) return;
        this.ADMIN_KEY = password;
        localStorage.setItem('admin_key', password);
        Promise.all([this.loadGroups(), this.loadSystemConfigs(), this.loadBotInfo()]).then(() => this.render());
      }

      logout() {
        this.ADMIN_KEY = '';
        localStorage.removeItem('admin_key');
        this.setState({
          currentTab: 'search',
          groups: [],
          systemConfigs: {},
          botInfo: null,
          showLogoutConfirm: false
        });
      }

      showToast(msg = '操作成功！', isError = false) {
        const toast = document.getElementById('toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.className = 'show' + (isError ? ' error' : '');
        setTimeout(() => toast.className = toast.className.replace('show', ''), 3000);
      }

      formatDateTime(timestamp) {
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

      escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }

      render() {
        const app = document.getElementById('app');
        if (!app) return;
        app.innerHTML = this.renderApp();
        this.bindDynamicEvents();
      }

      renderApp() {
        return \`
          <header class="bg-white shadow-lg sticky top-0 z-20">
            \${this.renderHeader()}
          </header>
          
          <nav class="bg-white border-b hidden md:block">
            \${this.renderNavigation()}
          </nav>
          
          <main class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
            \${this.renderMainContent()}
            \${this.renderModals()}
          </main>
        \`;
      }

      renderHeader() {
        return \`
          <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="p-2 bg-gradient-to-r from-purple-600 to-blue-600 rounded-lg">
                <i class="fas fa-code text-white text-xl"></i>
              </div>
              <div>
                <h1 class="text-2xl font-bold bg-gradient-to-r from-purple-600 to-blue-600 bg-clip-text text-transparent">
                  ShortX Method Hub
                </h1>
                <p class="text-gray-600 text-sm hidden md:block">方法知识库管理系统</p>
              </div>
            </div>

            <div class="hidden md:flex items-center gap-3">
              \${!this.ADMIN_KEY ? \`
                <input id="admin-password" type="password" placeholder="管理员密钥" 
                       class="px-4 py-2 border rounded-lg text-sm">
                <button id="login-btn" class="px-5 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition">
                  登录
                </button>
              \` : \`
                <span class="bg-green-100 text-green-700 px-3 py-1.5 rounded-lg text-sm">
                  <i class="fas fa-shield-alt mr-1"></i>管理员模式
                </span>
                <button id="logout-btn" class="text-red-600 hover:underline text-sm">退出</button>
              \`}
            </div>

            <button id="mobile-menu-btn" class="md:hidden text-gray-600 p-2">
              <i class="fas fa-bars text-xl"></i>
            </button>
          </div>

          <div id="mobile-menu" class="md:hidden bg-white border-t">
            \${this.renderMobileMenu()}
          </div>
        \`;
      }
      
      renderMobileMenu() {
        const tabs = [
          { id: 'search', icon: 'fa-search', label: '搜索方法' },
          { id: 'bot', icon: 'fa-robot', label: '机器人管理', requireAdmin: true },
          { id: 'admin', icon: 'fa-cogs', label: '管理面板', requireAdmin: true },
          { id: 'groups', icon: 'fa-users', label: '群组配置', requireAdmin: true },
          { id: 'forward', icon: 'fa-share-alt', label: '转发配置', requireAdmin: true },
          { id: 'settings', icon: 'fa-sliders-h', label: '系统设置', requireAdmin: true },
          { id: 'stats', icon: 'fa-chart-bar', label: '统计信息' }
        ];

        return \`
          <div class="px-6 py-4 space-y-4">
            \${tabs.map(tab => {
              if (tab.requireAdmin && !this.ADMIN_KEY) return '';
              return \`
                <button data-tab="\${tab.id}" class="flex items-center gap-2 w-full text-left py-2
                       \${this.state.currentTab === tab.id ? 'text-purple-600 font-bold' : 'text-gray-700'}">
                  <i class="fas \${tab.icon} mr-2"></i> \${tab.label}
                \`;
            }).join('')}

            <div class="border-t pt-4">
              \${!this.ADMIN_KEY ? \`
                <input id="mobile-password" type="password" placeholder="管理员密钥" 
                       class="w-full px-4 py-2 border rounded-lg text-sm mb-2">
                <button id="mobile-login-btn" class="w-full px-5 py-2 bg-purple-600 text-white rounded-lg text-sm hover:bg-purple-700 transition">
                  登录
                </button>
              \` : \`
                <div class="text-green-700 mb-2 text-sm">
                  <i class="fas fa-shield-alt mr-1"></i>管理员模式
                </div>
                <button id="mobile-logout-btn" class="w-full text-red-600 hover:underline py-2 text-left text-sm">
                  <i class="fas fa-sign-out-alt mr-1"></i>退出登录
                </button>
              \`}
            </div>
          </div>
        \`;
      }

      renderNavigation() {
        const tabs = [
          { id: 'search', icon: 'fa-search', label: '搜索方法' },
          { id: 'bot', icon: 'fa-robot', label: '机器人管理', requireAdmin: true },
          { id: 'admin', icon: 'fa-cogs', label: '管理面板', requireAdmin: true },
          { id: 'groups', icon: 'fa-users', label: '群组配置', requireAdmin: true },
          { id: 'forward', icon: 'fa-share-alt', label: '转发配置', requireAdmin: true },
          { id: 'settings', icon: 'fa-sliders-h', label: '系统设置', requireAdmin: true },
          { id: 'stats', icon: 'fa-chart-bar', label: '统计信息' }
        ];

        return \`
          <div class="max-w-7xl mx-auto px-6">
            <div class="flex gap-8 py-4 overflow-x-auto">
              \${tabs.map(tab => {
                if (tab.requireAdmin && !this.ADMIN_KEY) return '';
                return \`
                  <button data-tab="\${tab.id}" class="flex items-center gap-2 font-medium
                         \${this.state.currentTab === tab.id ? 
                           'text-purple-600 border-b-4 border-purple-600' : 
                           'text-gray-600'}">
                    <i class="fas \${tab.icon} text-sm"></i> \${tab.label}
                  </button>
                \`;
              }).join('')}
            </div>
          </div>
        \`;
      }

      renderMainContent() {
        switch (this.state.currentTab) {
          case 'search': return this.renderSearchView();
          case 'bot': return this.renderBotView();
          case 'admin': return this.renderAdminView();
          case 'groups': return this.renderGroupsView();
          case 'forward': return this.renderForwardConfigView();
          case 'settings': return this.renderSettingsView();
          case 'stats': return this.renderStatsView();
          default: return '';
        }
      }

      renderSearchView() {
        const allTags = [...new Set(this.state.methods.flatMap(m => m.tags || []))];
        
        return \`
          <div class="space-y-6">
            <div class="bg-white rounded-2xl shadow-lg p-6">
              <form id="search-form" class="flex gap-3 items-stretch">
                <input 
                  id="search-input"
                  type="text" 
                  placeholder="搜索标题、代码或标签..." 
                  value="\${this.escapeHtml(this.state.searchQuery)}" 
                  class="flex-1 min-w-0 px-5 py-3 border-2 border-gray-200 rounded-xl focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none transition"
                >
                <button 
                  type="submit" 
                  class="px-4 sm:px-6 py-3 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition flex items-center justify-center gap-2 flex-shrink-0 shadow-md hover:shadow-lg"
                >
                  <i class="fas fa-search"></i>
                  <span class="hidden sm:inline whitespace-nowrap">搜索</span>
                </button>
              </form>
              <div class="flex flex-wrap gap-3 mt-6">
                <button data-tag="" class="px-4 py-2 rounded-full \${this.state.selectedTag === '' ? 'bg-purple-600 text-white' : 'bg-gray-100 hover:bg-gray-200'} transition flex items-center gap-1">
                  <i class="fas fa-layer-group text-xs"></i> 全部
                </button>
                \${allTags.map(tag => \`
                  <button data-tag="\${this.escapeHtml(tag)}" class="px-4 py-2 rounded-full \${this.state.selectedTag === tag ? 'bg-purple-600 text-white' : 'bg-gray-100 hover:bg-gray-200'} transition flex items-center gap-1">
                    <i class="fas fa-tag text-xs"></i> #\${this.escapeHtml(tag)}
                  </button>
                \`).join('')}
              </div>
            </div>
            
            \${this.state.isSearching ? this.renderLoading() : this.renderMethods(false)}
          </div>
        \`;
      }

      renderBotView() {
        const botTabs = [
          { id: 'bot-commands', icon: 'fa-terminal', label: '命令管理' },
          { id: 'bot-config', icon: 'fa-cog', label: '配置设置' }
        ];
        
        const botCommands = [
          { command: '/start', description: '开始使用机器人' },
          { command: '/help', description: '查看帮助信息' },
          { command: '/search', description: '搜索方法代码' },
          { command: '/tags', description: '查看所有标签' },
          { command: '/tag', description: '按标签搜索方法' },
          { command: '/random', description: '随机获取方法' },
          { command: '/stats', description: '查看统计信息' }
        ];
        
        const enableBotSearch = this.state.systemConfigs.enable_bot_search !== '0';
        
        return \`
          <div class="space-y-8">
            <div class="flex justify-between items-center flex-wrap gap-4">
              <div>
                <h2 class="text-3xl font-bold text-gray-800 mb-1">机器人管理</h2>
                <p class="text-gray-600">管理 Telegram 机器人命令和配置</p>
              </div>
              <div class="flex gap-3">
                <button id="set-webhook-btn" class="px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-xl hover:shadow-lg transition flex items-center gap-2">
                  <i class="fas fa-link"></i> 设置 Webhook
                </button>
                <button id="set-commands-btn" class="px-6 py-3 bg-gradient-to-r from-green-500 to-green-600 text-white rounded-xl hover:shadow-lg transition flex items-center gap-2">
                  <i class="fas fa-terminal"></i> 设置命令
                </button>
              </div>
            </div>
            
            \${this.state.botInfo ? \`
              <div class="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-2xl p-6">
                <div class="flex items-center gap-4">
                  <div class="p-3 bg-gradient-to-r from-blue-500 to-indigo-600 rounded-xl">
                    <i class="fas fa-robot text-white text-2xl"></i>
                  </div>
                  <div>
                    <h3 class="text-xl font-bold text-gray-800">\${this.state.botInfo.result.username || '未知机器人'}</h3>
                    <p class="text-gray-600">ID: \${this.state.botInfo.result.id} • \${this.state.botInfo.result.first_name}</p>
                    \${this.state.botInfo.result.username ? \`
                      <a href="https://t.me/\${this.state.botInfo.result.username}" target="_blank" class="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 mt-2">
                        <i class="fab fa-telegram"></i>
                        <span>访问机器人</span>
                      </a>
                    \` : ''}
                  </div>
                </div>
              </div>
            \` : \`
              <div class="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-6">
                <div class="flex items-center gap-4">
                  <div class="p-3 bg-gradient-to-r from-amber-500 to-orange-600 rounded-xl">
                    <i class="fas fa-exclamation-triangle text-white text-2xl"></i>
                  </div>
                  <div>
                    <h3 class="text-xl font-bold text-gray-800">未配置机器人</h3>
                    <p class="text-gray-600">请先设置 Webhook 以启用机器人功能</p>
                  </div>
                </div>
              </div>
            \`}
            
            <div class="bg-white rounded-2xl shadow-lg overflow-hidden">
              <div class="border-b">
                <div class="flex">
                  \${botTabs.map(tab => \`
                    <button data-bot-tab="\${tab.id}" 
                            class="flex-1 px-6 py-4 text-center font-medium \${this.state.botTab === tab.id ? 'text-purple-600 border-b-2 border-purple-600' : 'text-gray-600 hover:text-gray-800'}">
                      <i class="fas \${tab.icon} mr-2"></i> \${tab.label}
                    </button>
                  \`).join('')}
                </div>
              </div>
              
              <div class="p-6">
                \${this.state.botTab === 'bot-commands' ? \`
                  <div class="space-y-6">
                    <div>
                      <h4 class="text-lg font-semibold text-gray-800 mb-4">机器人命令列表</h4>
                      <div class="space-y-3">
                        \${botCommands.map(cmd => \`
                          <div class="flex items-center justify-between p-4 border border-gray-200 rounded-xl hover:bg-gray-50 transition">
                            <div class="flex items-center gap-3">
                              <div class="p-2 bg-gradient-to-r from-purple-100 to-purple-200 rounded-lg">
                                <i class="fas fa-terminal text-purple-600"></i>
                              </div>
                              <div>
                                <span class="font-mono font-bold text-purple-700">\${cmd.command}</span>
                                <p class="text-gray-600 text-sm mt-1">\${cmd.description}</p>
                              </div>
                            </div>
                            <span class="px-3 py-1 bg-green-100 text-green-700 text-xs rounded-full">已配置</span>
                          </div>
                        \`).join('')}
                      </div>
                    </div>
                    
                    <div class="bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 rounded-xl p-5">
                      <div class="flex items-center gap-3 mb-3">
                        <i class="fas fa-info-circle text-green-600 text-xl"></i>
                        <h4 class="font-semibold text-green-800">使用说明</h4>
                      </div>
                      <div class="text-sm text-green-700 space-y-2">
                        <p>• 用户可以在 Telegram 中直接使用以上命令搜索方法</p>
                        <p>• 点击"设置命令"按钮将命令列表推送到机器人</p>
                        <p>• 机器人搜索功能可在"配置设置"中启用/禁用</p>
                        <p>• 确保机器人已添加到群组并拥有管理员权限</p>
                      </div>
                    </div>
                  </div>
                \` : \`
                  <div class="space-y-6">
                    <div class="flex items-center justify-between p-4 bg-gradient-to-r from-gray-50 to-gray-100 rounded-xl border border-gray-200">
                      <div class="flex-1">
                        <div class="flex items-center gap-3 mb-2">
                          <h4 class="font-semibold text-lg text-gray-800">启用机器人搜索功能</h4>
                          <label class="relative inline-flex items-center cursor-pointer">
                            <input 
                              type="checkbox" 
                              id="bot-enable-search"
                              \${enableBotSearch ? 'checked' : ''} 
                              class="sr-only peer"
                            >
                            <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gradient-to-r peer-checked:from-purple-600 peer-checked:to-purple-700"></div>
                          </label>
                        </div>
                        <div class="text-sm text-gray-600 space-y-2">
                          <p><strong>开启：</strong>用户可以在 Telegram 中使用命令搜索方法</p>
                          <p><strong>关闭：</strong>机器人仅处理群组消息采集，不接受搜索命令</p>
                        </div>
                      </div>
                    </div>
                    
                    <div class="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5">
                      <div class="flex items-start gap-3">
                        <i class="fas fa-cogs text-blue-600 text-xl mt-1"></i>
                        <div>
                          <p class="font-semibold text-blue-800 mb-2">机器人配置提示</p>
                          <ul class="text-sm text-blue-700 space-y-2">
                            <li>• 机器人需要管理员权限才能处理群组消息</li>
                            <li>• Webhook 设置只需执行一次</li>
                            <li>• 命令列表设置后，用户可以在 Telegram 中看到命令提示</li>
                            <li>• 建议在设置 Webhook 后立即设置命令</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                \`}
              </div>
            </div>
          </div>
        \`;
      }

      renderAdminView() {
        return \`
          <div class="space-y-6">
            <div class="flex justify-between items-center flex-wrap gap-4">
              <div>
                <h2 class="text-3xl font-bold text-gray-800 mb-1">管理面板</h2>
                <p class="text-gray-600">管理所有方法，验证后才会出现在 ShortX API 中</p>
              </div>
              <div class="flex gap-3 flex-wrap">
                <button id="add-method-btn" class="px-6 py-3 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl hover:shadow-lg transition flex items-center gap-2">
                  <i class="fas fa-plus"></i> 添加方法
                </button>
                <a href="\${this.API_BASE}/api/export" class="px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-xl hover:shadow-lg transition flex items-center gap-2">
                  <i class="fas fa-download"></i> 导出 JSON
                </a>
                <a href="\${this.API_BASE}/api/shortx/methods.json" class="px-6 py-3 bg-gradient-to-r from-purple-500 to-purple-600 text-white rounded-xl hover:shadow-lg transition flex items-center gap-2">
                  <i class="fas fa-code"></i> ShortX 格式
                </a>
              </div>
            </div>
            <div class="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-5">
              <div class="flex items-start gap-3">
                <i class="fas fa-info-circle text-amber-600 text-xl mt-1"></i>
                <div>
                  <p class="text-amber-800 font-medium">使用说明：</p>
                  <p class="text-amber-700 text-sm">点击 ✓ 标记已验证，仅已验证方法会出现在 ShortX 接口。获取历史消息请前往"转发配置"页面。</p>
                </div>
              </div>
            </div>
            \${this.renderMethods(true)}
          </div>
        \`;
      }

      renderMethods(isAdmin) {
        if (this.state.methods.length === 0) {
          return \`
            <div class="text-center py-12">
              <i class="fas fa-inbox text-gray-300 text-5xl mb-4"></i>
              <p class="text-gray-500">暂无方法</p>
            </div>
          \`;
        }
        
        return \`
          <div class="columns-1 gap-6 sm:columns-2 md:columns-3 lg:columns-4">
            \${this.state.methods.map(method => this.renderMethodCard(method, isAdmin)).join('')}
          </div>
        \`;
      }

      renderMethodCard(method, isAdmin) {
        return \`
          <div class="bg-white rounded-2xl shadow-lg break-inside-avoid mb-6 overflow-hidden flex flex-col border border-gray-100 hover:border-purple-200 transition">
            <div class="p-5 flex flex-col flex-1">
              <div class="flex justify-between items-start mb-3">
                <h3 class="text-lg font-bold flex items-center gap-2 flex-wrap">
                  <i class="fas fa-file-code text-purple-500"></i>
                  \${this.escapeHtml(method.title)}
                  \${method.verified ? '<span class="inline-flex items-center px-2.5 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full"><i class="fas fa-check mr-1"></i>已验证</span>' : ''}
                </h3>
                \${!isAdmin ? \`
                  <button data-copy="\${method.id}" class="px-4 py-2 bg-gradient-to-r from-purple-500 to-purple-600 text-white text-sm rounded-lg hover:shadow-md transition flex-shrink-0 flex items-center gap-1">
                    <i class="fas fa-copy text-xs"></i> 复制
                  </button>
                \` : ''}
              </div>
              <div class="text-xs text-gray-500 mb-3 space-y-1">
                <div class="flex flex-wrap gap-2 items-center">
                  <span><i class="fas fa-user text-gray-400"></i> \${this.escapeHtml(method.author || 'anonymous')}</span>
                  \${method.link ? \`
                    <a href="\${this.escapeHtml(method.link)}" target="_blank" class="text-blue-600 hover:underline flex items-center gap-1">
                      <i class="fas fa-external-link-alt text-xs"></i> 来源
                    </a>
                  \` : ''}
                </div>
                <div class="flex flex-col gap-0.5">
                  <span><i class="far fa-calendar text-gray-400"></i> 创建: \${this.formatDateTime(method.created_at)}</span>
                  \${method.updated_at ? \`
                    <span class="text-orange-600"><i class="fas fa-sync-alt text-xs"></i> 更新: \${this.formatDateTime(method.updated_at)}</span>
                  \` : ''}
                </div>
              </div>
              <div class="code-block flex-1 mb-4">
                <pre class="bg-gray-50 rounded-lg p-3 text-xs border border-gray-200"><code>\${this.escapeHtml(method.code)}</code></pre>
              </div>
              <div class="flex flex-wrap gap-1.5">
                \${(method.tags || []).map(tag => \`
                  <span class="px-2.5 py-1 bg-gradient-to-r from-purple-50 to-blue-50 text-purple-700 rounded-full text-xs font-medium border border-purple-100 flex items-center gap-1">
                    <i class="fas fa-hashtag text-xs"></i>\${this.escapeHtml(tag)}
                  </span>
                \`).join('')}
              </div>
              \${isAdmin ? \`
                <div class="flex justify-end gap-2 mt-4 pt-3 border-t">
                  <button data-verify="\${method.id}:\${method.verified}" 
                          class="p-2 rounded-lg \${method.verified ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-gray-100 border border-gray-200'} hover:opacity-80 transition text-sm flex items-center justify-center w-10"
                          title="\${method.verified ? '取消验证' : '标记验证'}">
                    <i class="fas \${method.verified ? 'fa-check-circle' : 'fa-check'}"></i>
                  </button>
                  <button data-edit="\${method.id}" 
                          class="p-2 bg-blue-100 text-blue-700 rounded-lg hover:bg-blue-200 transition text-sm flex items-center justify-center w-10"
                          title="编辑">
                    <i class="fas fa-edit"></i>
                  </button>
                  <button data-delete="\${method.id}" 
                          class="p-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 transition text-sm flex items-center justify-center w-10"
                          title="删除">
                    <i class="fas fa-trash-alt"></i>
                  </button>
                </div>
              \` : ''}
            </div>
          </div>
        \`;
      }

      renderGroupsView() {
        const getChatTypeText = (type) => {
          const types = {
            'group': '普通群组',
            'supergroup': '超级群组',
            'channel': '频道'
          };
          return types[type] || type;
        };

        const getChatTypeIcon = (type) => {
          const icons = {
            'group': 'fa-users',
            'supergroup': 'fa-users',
            'channel': 'fa-broadcast-tower'
          };
          return icons[type] || 'fa-comments';
        };

        const getChatTypeBadge = (type) => {
          const badges = {
            'group': 'bg-gradient-to-r from-blue-100 to-blue-50 text-blue-700 border border-blue-200',
            'supergroup': 'bg-gradient-to-r from-purple-100 to-purple-50 text-purple-700 border border-purple-200',
            'channel': 'bg-gradient-to-r from-green-100 to-green-50 text-green-700 border border-green-200'
          };
          return badges[type] || 'bg-gray-100 text-gray-700';
        };

        return \`
          <div class="space-y-8">
            <div class="flex justify-between items-center flex-wrap gap-4">
              <div>
                <h2 class="text-3xl font-bold text-gray-800 mb-1">群组配置</h2>
                <p class="text-gray-600">配置 Bot 从哪些群组和话题采集方法</p>
              </div>
              <div class="flex gap-3">
                <button id="validate-groups-btn" \${this.state.isValidating ? 'disabled' : ''} 
                        class="px-4 py-2 bg-gradient-to-r from-orange-500 to-orange-600 text-white rounded-lg hover:shadow-lg transition flex items-center gap-2">
                  \${this.state.isValidating ? \`
                    <i class="fas fa-spinner fa-spin"></i>
                    验证中...
                  \` : \`
                    <i class="fas fa-trash-alt"></i>
                    清理失效
                  \`}
                </button>
                <button id="refresh-groups-btn" class="px-4 py-2 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-lg hover:shadow-lg transition flex items-center gap-2">
                  <i class="fas fa-sync-alt"></i>
                  刷新列表
                </button>
              </div>
            </div>
            <div class="bg-white rounded-2xl shadow-lg p-6">
              <div class="flex items-start gap-3 mb-6">
                <div class="p-2 bg-gradient-to-r from-blue-100 to-purple-100 rounded-lg">
                  <i class="fas fa-info-circle text-blue-600 text-xl"></i>
                </div>
                <div>
                  <p class="text-gray-700 font-medium">配置说明</p>
                  <p class="text-gray-600 text-sm">Bot 必须是管理员才能工作。启用后，Bot 会自动采集该群组中符合条件的消息。</p>
                </div>
              </div>
              <div class="space-y-6">
                \${this.state.groups.length === 0 ? \`
                  <div class="text-center py-8">
                    <i class="fas fa-users text-gray-300 text-5xl mb-4"></i>
                    <p class="text-gray-500">暂无群组（将 Bot 添加为群组管理员后会自动出现）</p>
                  </div>
                \` : this.state.groups.map(group => {
                  const safeChatId = group.chat_id.replace(/[^a-zA-Z0-9]/g, '_');
                  return \`
                    <div class="border border-gray-200 rounded-xl p-6 hover:shadow-md transition config-card">
                      <div class="flex items-center justify-between mb-4 flex-wrap gap-4">
                        <div>
                          <div class="flex items-center gap-2 mb-1">
                            <i class="fas \${getChatTypeIcon(group.chat_type)} text-gray-500"></i>
                            <h3 class="text-xl font-semibold text-gray-800">\${this.escapeHtml(group.chat_title)}</h3>
                            <span class="px-2 py-1 rounded-full text-xs font-medium \${getChatTypeBadge(group.chat_type)}">
                              \${getChatTypeText(group.chat_type)}
                            </span>
                          </div>
                          <p class="text-sm text-gray-500"><i class="fas fa-hashtag text-xs"></i> Chat ID: \${this.escapeHtml(group.chat_id)}</p>
                        </div>
                        <label class="relative inline-flex items-center cursor-pointer">
                          <input type="checkbox" id="toggle_\${safeChatId}" data-group-toggle="\${group.chat_id}" 
                                 \${group.enabled ? 'checked' : ''} class="sr-only peer">
                          <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gradient-to-r peer-checked:from-purple-600 peer-checked:to-purple-700"></div>
                          <span class="ml-3 text-sm font-medium text-gray-900">\${group.enabled ? '已启用' : '已禁用'}</span>
                        </label>
                      </div>
                      <div class="space-y-4">
                        \${group.chat_type === 'supergroup' ? \`
                          <div>
                            <label class="block text-sm font-medium text-gray-700 mb-2">
                              <i class="fas fa-comment-dots mr-1"></i> 允许采集的话题 ID
                            </label>
                            <div class="flex gap-2">
                              <input id="threads_\${safeChatId}" type="text" value="\${this.escapeHtml(group.allowed_thread_ids)}" 
                                     placeholder="例如: 123,456,789" 
                                     class="flex-1 min-w-0 px-4 py-2 border border-gray-300 rounded-lg focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none text-sm">
                              <button data-group-save="\${group.chat_id}" 
                                      class="px-4 py-2 bg-gradient-to-r from-purple-500 to-purple-600 text-white rounded-lg hover:shadow-md transition whitespace-nowrap flex-shrink-0 text-sm flex items-center gap-2">
                                <i class="fas fa-save text-xs"></i> 保存
                              </button>
                            </div>
                            <p class="text-xs text-gray-500 mt-1">逗号分隔，留空表示所有话题</p>
                          </div>
                        \` : \`
                          <input type="hidden" id="threads_\${safeChatId}" value="">
                          <div class="text-sm text-gray-500 italic flex items-center gap-2">
                            <i class="fas \${group.chat_type === 'channel' ? 'fa-broadcast-tower' : 'fa-comments'}"></i>
                            \${group.chat_type === 'channel' ? '📢 频道不支持话题功能' : '💬 普通群组不支持话题功能'}
                          </div>
                        \`}
                        <div class="flex gap-2 pt-2 border-t">
                          <button data-history="\${group.chat_id}" class="flex-1 px-4 py-2 bg-gradient-to-r from-orange-500 to-orange-600 text-white rounded-lg hover:shadow-md transition text-sm flex items-center justify-center gap-2">
                            <i class="fas fa-history"></i>
                            获取历史消息
                          </button>
                        </div>
                      </div>
                    </div>
                  \`;
                }).join('')}
              </div>
            </div>
          </div>
        \`;
      }

      renderForwardConfigView() {
        const forwardMethod = this.state.systemConfigs.forward_method || 'in_situ';
        const forwardApi = this.state.systemConfigs.forward_api || 'forwardMessage';
        const autoDelete = this.state.systemConfigs.auto_delete !== '0';
        
        const forwardMethods = [
          { id: 'in_situ', icon: 'fa-retweet', title: '原位转发', desc: '在同一群组内转发并提取', color: 'from-green-500 to-emerald-600' },
          { id: 'admin', icon: 'fa-user-shield', title: '管理员', desc: '转发给管理员用户', color: 'from-blue-500 to-blue-600' },
          { id: 'custom', icon: 'fa-share-alt', title: '指定目标', desc: '转发到指定群组/频道', color: 'from-purple-500 to-purple-600' }
        ];
        
        const forwardApis = [
          { id: 'forwardMessage', title: 'forwardMessage', desc: '直接转发消息（保留转发标记）' },
          { id: 'copyMessage', title: 'copyMessage', desc: '复制消息（不显示转发来源）' }
        ];
        
        return \`
          <div class="space-y-8">
            <div class="flex justify-between items-center flex-wrap gap-4">
              <div>
                <h2 class="text-3xl font-bold text-gray-800 mb-1">转发配置</h2>
                <p class="text-gray-600">配置历史消息采集的转发方式和参数</p>
              </div>
              <button id="save-config-btn" class="px-6 py-3 bg-gradient-to-r from-purple-500 to-purple-600 text-white rounded-xl hover:shadow-lg transition flex items-center gap-2">
                <i class="fas fa-save"></i> 保存配置
              </button>
            </div>
            
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div class="bg-white rounded-2xl shadow-lg p-6 config-card">
                <div class="flex items-center gap-3 mb-6">
                  <div class="p-2 bg-gradient-to-r from-purple-100 to-pink-100 rounded-lg">
                    <i class="fas fa-share-alt text-purple-600 text-xl"></i>
                  </div>
                  <div>
                    <h3 class="text-xl font-semibold text-gray-800">转发模式</h3>
                    <p class="text-gray-600 text-sm">选择采集历史消息时的转发方式</p>
                  </div>
                </div>
                
                <div class="space-y-4">
                  \${forwardMethods.map(method => \`
                    <div data-method="\${method.id}" 
                         class="forward-option border-2 rounded-xl p-4 cursor-pointer \${forwardMethod === method.id ? 'active border-purple-500' : 'border-gray-200'}">
                      <div class="flex items-center gap-4">
                        <div class="p-3 bg-gradient-to-r \${method.color} rounded-lg">
                          <i class="fas \${method.icon} text-white text-lg"></i>
                        </div>
                        <div class="flex-1">
                          <div class="flex justify-between items-center">
                            <h4 class="font-semibold text-gray-800">\${method.title}</h4>
                            \${forwardMethod === method.id ? '<span class="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full"><i class="fas fa-check mr-1"></i>已选择</span>' : ''}
                          </div>
                          <p class="text-sm text-gray-600 mt-1">\${method.desc}</p>
                        </div>
                      </div>
                    </div>
                  \`).join('')}
                  
                  \${forwardMethod === 'admin' ? \`
                    <div class="bg-blue-50 border border-blue-200 rounded-xl p-4 mt-4">
                      <div class="flex items-center gap-3 mb-3">
                        <i class="fas fa-user-shield text-blue-600"></i>
                        <h4 class="font-semibold text-blue-800">管理员模式配置</h4>
                      </div>
                      <div class="space-y-3">
                        <div>
                          <label class="block text-sm font-medium text-gray-700 mb-2">管理员用户 ID</label>
                          <input 
                            type="text" 
                            value="\${this.escapeHtml(this.state.systemConfigs.admin_user_id || '')}"
                            id="admin-user-id"
                            placeholder="例如：123456789"
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none"
                          >
                          <p class="text-xs text-gray-500 mt-1">Bot 拥有者的 Telegram User ID</p>
                        </div>
                      </div>
                    </div>
                  \` : forwardMethod === 'custom' ? \`
                    <div class="bg-purple-50 border border-purple-200 rounded-xl p-4 mt-4">
                      <div class="flex items-center gap-3 mb-3">
                        <i class="fas fa-share-alt text-purple-600"></i>
                        <h4 class="font-semibold text-purple-800">指定目标模式配置</h4>
                      </div>
                      <div class="space-y-3">
                        <div>
                          <label class="block text-sm font-medium text-gray-700 mb-2">目标群组/频道 ID</label>
                          <input 
                            type="text" 
                            value="\${this.escapeHtml(this.state.systemConfigs.forward_target || '')}"
                            id="forward-target"
                            placeholder="例如：-1001234567890"
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none"
                          >
                          <p class="text-xs text-gray-500 mt-1">Bot 必须是目标群组的管理员</p>
                        </div>
                        <div>
                          <label class="block text-sm font-medium text-gray-700 mb-2">目标话题 ID（可选）</label>
                          <input 
                            type="text" 
                            value="\${this.escapeHtml(this.state.systemConfigs.forward_thread_id || '')}"
                            id="forward-thread-id"
                            placeholder="例如：123（仅超级群组需要）"
                            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none"
                          >
                          <p class="text-xs text-gray-500 mt-1">仅适用于超级群组的话题功能</p>
                        </div>
                      </div>
                    </div>
                  \` : \`
                    <div class="bg-green-50 border border-green-200 rounded-xl p-4 mt-4">
                      <div class="flex items-center gap-3 mb-3">
                        <i class="fas fa-retweet text-green-600"></i>
                        <h4 class="font-semibold text-green-800">原位转发模式</h4>
                      </div>
                      <p class="text-sm text-green-700">消息将在同一群组内转发并提取代码，干扰最小。</p>
                      <p class="text-sm text-green-600 mt-2">如需转发到特定话题，请在"获取历史消息"时提供话题ID。</p>
                    </div>
                  \`}
                </div>
              </div>
              
              <div class="bg-white rounded-2xl shadow-lg p-6 config-card">
                <div class="flex items-center gap-3 mb-6">
                  <div class="p-2 bg-gradient-to-r from-blue-100 to-cyan-100 rounded-lg">
                    <i class="fas fa-cogs text-blue-600 text-xl"></i>
                  </div>
                  <div>
                    <h3 class="text-xl font-semibold text-gray-800">高级配置</h3>
                    <p class="text-gray-600 text-sm">配置转发 API 和清理选项</p>
                  </div>
                </div>
                
                <div class="space-y-6">
                  <div>
                    <h4 class="font-semibold text-gray-800 mb-3 flex items-center gap-2">
                      <i class="fas fa-code-branch text-purple-500"></i>
                      转发 API
                    </h4>
                    <div class="space-y-3">
                      \${forwardApis.map(api => \`
                        <div class="flex items-center justify-between p-3 border border-gray-200 rounded-lg hover:bg-gray-50">
                          <div>
                            <div class="flex items-center gap-3">
                              <input 
                                type="radio" 
                                name="forward-api" 
                                id="api-\${api.id}" 
                                value="\${api.id}" 
                                \${forwardApi === api.id ? 'checked' : ''}
                                data-api="\${api.id}"
                                class="text-purple-600 focus:ring-purple-500"
                              >
                              <label for="api-\${api.id}" class="cursor-pointer">
                                <span class="font-medium text-gray-800">\${api.title}</span>
                                <p class="text-sm text-gray-600 mt-1">\${api.desc}</p>
                              </label>
                            </div>
                          </div>
                          \${forwardApi === api.id ? '<span class="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full"><i class="fas fa-check"></i></span>' : ''}
                        </div>
                      \`).join('')}
                    </div>
                  </div>
                  
                  <div class="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-4">
                    <div class="flex items-center justify-between mb-3">
                      <div class="flex items-center gap-3">
                        <i class="fas fa-trash-alt text-amber-600 text-lg"></i>
                        <div>
                          <h4 class="font-semibold text-gray-800">自动销毁临时消息</h4>
                          <p class="text-sm text-gray-600">开启后，转发的临时消息会自动删除</p>
                        </div>
                      </div>
                      <label class="relative inline-flex items-center cursor-pointer">
                        <input 
                          type="checkbox" 
                          id="auto-delete"
                          \${autoDelete ? 'checked' : ''} 
                          class="sr-only peer"
                        >
                        <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gradient-to-r peer-checked:from-purple-600 peer-checked:to-purple-700"></div>
                      </label>
                    </div>
                    \${autoDelete ? \`
                      <div class="bg-white rounded-lg p-3 mt-3 border border-green-200">
                        <div class="flex items-start gap-2">
                          <i class="fas fa-check-circle text-green-500 mt-0.5"></i>
                          <p class="text-sm text-green-700">已开启自动销毁，所有临时转发的消息都会被立即删除，确保聊天环境整洁。</p>
                        </div>
                      </div>
                    \` : \`
                      <div class="bg-white rounded-lg p-3 mt-3 border border-red-200">
                        <div class="flex items-start gap-2">
                          <i class="fas fa-exclamation-triangle text-red-500 mt-0.5"></i>
                          <p class="text-sm text-red-700">自动销毁已关闭，转发的消息会保留在目标聊天中，请注意清理。</p>
                        </div>
                      </div>
                    \`}
                  </div>
                </div>
              </div>
            </div>
          </div>
        \`;
      }

      renderSettingsView() {
        const shortxRequireVerified = this.state.systemConfigs.shortx_require_verified !== '0';
        
        return \`
          <div class="space-y-8">
            <div class="flex justify-between items-center">
              <div>
                <h2 class="text-3xl font-bold text-gray-800 mb-1">系统设置</h2>
                <p class="text-gray-600">配置 ShortX API 和其他系统参数</p>
              </div>
              <button id="save-settings-btn" class="px-6 py-3 bg-gradient-to-r from-purple-500 to-purple-600 text-white rounded-xl hover:shadow-lg transition flex items-center gap-2">
                <i class="fas fa-save"></i> 保存所有设置
              </button>
            </div>
            
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div class="bg-white rounded-2xl shadow-lg p-6 config-card">
                <div class="flex items-center gap-3 mb-6">
                  <div class="p-2 bg-gradient-to-r from-purple-100 to-pink-100 rounded-lg">
                    <i class="fas fa-code text-purple-600 text-xl"></i>
                  </div>
                  <div>
                    <h3 class="text-xl font-semibold text-gray-800">ShortX API 配置</h3>
                    <p class="text-gray-600 text-sm">配置 ShortX 应用使用的 API 接口</p>
                  </div>
                </div>
                
                <div class="space-y-6">
                  <div class="flex items-start justify-between p-4 bg-gradient-to-r from-gray-50 to-gray-100 rounded-lg border border-gray-200">
                    <div class="flex-1">
                      <div class="flex items-center gap-3 mb-2">
                        <h4 class="font-semibold text-lg text-gray-800">仅导出已验证方法</h4>
                        <label class="relative inline-flex items-center cursor-pointer">
                          <input 
                            type="checkbox" 
                            id="shortx-require-verified"
                            \${shortxRequireVerified ? 'checked' : ''} 
                            class="sr-only peer"
                          >
                          <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gradient-to-r peer-checked:from-purple-600 peer-checked:to-purple-700"></div>
                        </label>
                      </div>
                      <div class="text-sm text-gray-600 space-y-2">
                        <p><strong>开启（推荐）：</strong>ShortX API 仅返回已验证的方法，确保代码质量</p>
                        <p><strong>关闭：</strong>ShortX API 返回所有方法，包括未验证的</p>
                      </div>
                    </div>
                  </div>
                  
                  <div class="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5">
                    <div class="flex items-start gap-3">
                      <i class="fas fa-link text-blue-600 text-xl mt-1"></i>
                      <div>
                        <p class="font-semibold text-blue-800 mb-2">API 访问地址</p>
                        <div class="bg-white rounded-lg p-3 border border-blue-200 mb-3">
                          <code class="text-sm font-mono text-blue-700 break-all">\${this.API_BASE}/api/shortx/methods.json</code>
                        </div>
                        <p class="text-sm text-blue-700">此接口无需认证，可直接在 ShortX 应用中使用。</p>
                        <p class="text-sm text-blue-600 mt-2">接口返回格式与 ShortX 应用完全兼容。</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        \`;
      }

      renderStatsView() {
        return \`
          <div class="space-y-8">
            <div>
              <h2 class="text-3xl font-bold text-gray-800 mb-1">统计信息</h2>
              <p class="text-gray-600">系统运行数据和统计概览</p>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div class="bg-gradient-to-br from-purple-500 to-purple-600 rounded-2xl shadow-lg p-8 text-center text-white">
                <i class="fas fa-file-code text-4xl mb-4 opacity-90"></i>
                <p class="text-xl mb-2">总方法数</p>
                <p class="text-5xl font-bold">\${this.state.stats.total || 0}</p>
              </div>
              <div class="bg-gradient-to-br from-green-500 to-emerald-600 rounded-2xl shadow-lg p-8 text-center text-white">
                <i class="fas fa-check-circle text-4xl mb-4 opacity-90"></i>
                <p class="text-xl mb-2">已验证方法</p>
                <p class="text-5xl font-bold">\${this.state.stats.verified || 0}</p>
              </div>
              <div class="bg-gradient-to-br from-blue-500 to-cyan-600 rounded-2xl shadow-lg p-8 text-center text-white">
                <i class="fas fa-tags text-4xl mb-4 opacity-90"></i>
                <p class="text-xl mb-2">标签种类</p>
                <p class="text-5xl font-bold">\${this.state.stats.tags || 0}</p>
              </div>
            </div>
            
            \${this.state.stats.tagCounts && Object.keys(this.state.stats.tagCounts).length > 0 ? \`
              <div class="bg-white rounded-2xl shadow-lg p-6">
                <h3 class="text-xl font-semibold text-gray-800 mb-6">热门标签分布</h3>
                <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                  \${Object.entries(this.state.stats.tagCounts)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 12)
                    .map(([tag, count]) => \`
                    <div class="bg-gradient-to-r from-gray-50 to-gray-100 rounded-xl p-4 border border-gray-200">
                      <div class="flex items-center gap-2 mb-2">
                        <i class="fas fa-hashtag text-purple-500"></i>
                        <span class="font-medium text-gray-800 truncate">\${this.escapeHtml(tag)}</span>
                      </div>
                      <div class="flex items-center justify-between">
                        <span class="text-2xl font-bold text-purple-600">\${count}</span>
                        <span class="text-sm text-gray-500">个方法</span>
                      </div>
                    </div>
                  \`).join('')}
                </div>
              </div>
            \` : ''}
          </div>
        \`;
      }

      renderLoading() {
        return \`
          <div class="flex items-center justify-center py-12">
            <div class="flex items-center gap-3 text-purple-600">
              <i class="fas fa-spinner fa-spin text-2xl"></i>
              <span class="text-lg font-medium">正在加载...</span>
            </div>
          </div>
        \`;
      }

      renderModals() {
        let modals = '';
        
        if (this.state.showModal) {
          modals += this.renderMethodModal();
        }
        
        if (this.state.showDeleteConfirm) {
          modals += this.renderDeleteModal();
        }
        
        if (this.state.showLogoutConfirm) {
          modals += this.renderLogoutModal();
        }
        
        if (this.state.showHistoryModal) {
          modals += this.renderHistoryModal();
        }
        
        return modals;
      }

      renderMethodModal() {
        const m = this.state.editing || {title: '', code: '', tags: [], link: ''};
        
        return \`
          <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto p-8">
              <div class="flex items-center justify-between mb-6">
                <h3 class="text-2xl font-bold text-gray-800">\${this.state.editing ? '编辑方法' : '添加方法'}</h3>
                <button data-close="modal" class="text-gray-500 hover:text-gray-700">
                  <i class="fas fa-times text-xl"></i>
                </button>
              </div>
              <div class="space-y-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-2">标题</label>
                  <input id="m-title" value="\${this.escapeHtml(m.title)}" placeholder="输入方法标题" 
                         class="w-full px-5 py-3 border border-gray-300 rounded-xl focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none">
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-2">代码</label>
                  <textarea id="m-code" rows="12" placeholder="粘贴代码内容" 
                            class="w-full px-5 py-3 border border-gray-300 rounded-xl font-mono text-sm focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none">\${this.escapeHtml(m.code)}</textarea>
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-2">标签（逗号分隔）</label>
                  <input id="m-tags" value="\${this.escapeHtml((m.tags || []).join(', '))}" 
                         placeholder="例如: JavaScript, MVEL, 函数" 
                         class="w-full px-5 py-3 border border-gray-300 rounded-xl focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none">
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700 mb-2">来源链接（可选）</label>
                  <input id="m-link" value="\${this.escapeHtml(m.link || '')}" placeholder="https://..." 
                         class="w-full px-5 py-3 border border-gray-300 rounded-xl focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none">
                </div>
              </div>
              <div class="flex justify-end gap-4 mt-6 pt-6 border-t">
                <button data-close="modal" class="px-6 py-3 bg-gray-200 text-gray-700 rounded-xl hover:bg-gray-300 transition">取消</button>
                <button id="method-save-btn" class="px-6 py-3 bg-gradient-to-r from-purple-500 to-purple-600 text-white rounded-xl hover:shadow-lg transition">保存</button>
              </div>
            </div>
          </div>
        \`;
      }

      renderDeleteModal() {
        const m = this.state.methods.find(x => x.id === this.state.deletingId);
        if (!m) return '';
        
        return \`
          <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
              <div class="text-center mb-6">
                <div class="mx-auto w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
                  <i class="fas fa-exclamation-triangle text-red-600 text-2xl"></i>
                </div>
                <h3 class="text-2xl font-bold text-gray-800 mb-2">确认删除</h3>
                <p class="text-gray-600">确定要永久删除此方法吗？此操作不可恢复。</p>
              </div>
              <div class="bg-gray-50 rounded-xl p-4 mb-6 border border-gray-200">
                <div class="flex items-center gap-3 mb-2">
                  <i class="fas fa-file-code text-purple-500"></i>
                  <p class="font-semibold text-gray-800">\${this.escapeHtml(m.title)}</p>
                </div>
                <div class="text-sm text-gray-500">
                  <div class="flex items-center gap-2">
                    <i class="fas fa-user"></i>
                    作者: \${this.escapeHtml(m.author || 'anonymous')}
                  </div>
                  \${m.tags && m.tags.length > 0 ? \`
                    <div class="flex items-center gap-2 mt-1">
                      <i class="fas fa-tags"></i>
                      标签: \${this.escapeHtml(m.tags.join(', '))}
                    </div>
                  \` : ''}
                </div>
              </div>
              <div class="flex justify-end gap-4">
                <button data-close="delete" class="px-6 py-3 bg-gray-200 text-gray-700 rounded-xl hover:bg-gray-300 transition">取消</button>
                <button id="confirm-delete-btn" class="px-6 py-3 bg-gradient-to-r from-red-500 to-red-600 text-white rounded-xl hover:shadow-lg transition">删除</button>
              </div>
            </div>
          </div>
        \`;
      }

      renderLogoutModal() {
        return \`
          <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
              <div class="text-center mb-6">
                <div class="mx-auto w-16 h-16 bg-orange-100 rounded-full flex items-center justify-center mb-4">
                  <i class="fas fa-sign-out-alt text-orange-600 text-2xl"></i>
                </div>
                <h3 class="text-2xl font-bold text-gray-800 mb-2">退出登录</h3>
                <p class="text-gray-600">确定要退出管理员模式吗？</p>
              </div>
              <div class="flex justify-end gap-4">
                <button data-close="logout" class="px-6 py-3 bg-gray-200 text-gray-700 rounded-xl hover:bg-gray-300 transition">取消</button>
                <button id="confirm-logout-btn" class="px-6 py-3 bg-gradient-to-r from-orange-500 to-orange-600 text-white rounded-xl hover:shadow-lg transition">退出</button>
              </div>
            </div>
          </div>
        \`;
      }

      renderHistoryModal() {
        const forwardMethod = this.state.systemConfigs.forward_method || 'in_situ';
        const forwardApi = this.state.systemConfigs.forward_api || 'forwardMessage';
        const autoDelete = this.state.systemConfigs.auto_delete !== '0';
        
        let methodText = '';
        let targetText = '';
        
        switch(forwardMethod) {
          case 'in_situ':
            methodText = '原位转发（同群组内）';
            targetText = '原群组';
            break;
          case 'admin':
            methodText = '转发给管理员';
            targetText = \`管理员用户（ID: \${this.state.systemConfigs.admin_user_id || '未设置'}）\`;
            break;
          case 'custom':
            methodText = '转发到指定群组';
            targetText = \`目标群组（ID: \${this.state.systemConfigs.forward_target || '未设置'}）\`;
            if (this.state.systemConfigs.forward_thread_id) {
              targetText += \`，话题ID：\${this.state.systemConfigs.forward_thread_id}\`;
            }
            break;
        }
        
        return \`
          <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-8">
              <div class="flex items-center justify-between mb-6">
                <h3 class="text-2xl font-bold text-gray-800">获取历史消息</h3>
                <button data-close="history" class="text-gray-500 hover:text-gray-700">
                  <i class="fas fa-times text-xl"></i>
                </button>
              </div>
              
              <div class="space-y-6">
                <div class="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-5">
                  <div class="flex items-center gap-3 mb-3">
                    <i class="fas fa-cogs text-blue-600"></i>
                    <h4 class="font-semibold text-blue-800">当前转发配置</h4>
                  </div>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                    <div>
                      <span class="text-gray-600">转发模式：</span>
                      <span class="font-medium text-gray-800">\${methodText}</span>
                    </div>
                    <div>
                      <span class="text-gray-600">转发 API：</span>
                      <span class="font-medium text-gray-800">\${forwardApi}</span>
                    </div>
                    <div>
                      <span class="text-gray-600">目标位置：</span>
                      <span class="font-medium text-gray-800">\${targetText}</span>
                    </div>
                    <div>
                      <span class="text-gray-600">自动销毁：</span>
                      <span class="font-medium \${autoDelete ? 'text-green-600' : 'text-red-600'}">\${autoDelete ? '已开启' : '已关闭'}</span>
                    </div>
                  </div>
                </div>
                
                <div class="space-y-4">
                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">
                      <i class="fas fa-hashtag mr-1"></i> Chat ID（自动填充）
                    </label>
                    <input id="history-chat-id" type="text" readonly 
                           class="w-full px-5 py-3 border border-gray-300 rounded-xl bg-gray-50 focus:outline-none" 
                           value="\${this.escapeHtml(this.state.selectedChatId)}">
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">
                      <i class="fas fa-envelope mr-1"></i> 消息 ID（必填）
                    </label>
                    <textarea id="history-message-ids" rows="3" 
                              placeholder="例如: 123, 125, 130, 145
或: 123,125,130,145" 
                              class="w-full px-5 py-3 border border-gray-300 rounded-xl font-mono text-sm focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none"></textarea>
                    <p class="text-xs text-gray-500 mt-1">支持逗号分隔的多个消息 ID，系统会逐个处理</p>
                  </div>
                  <div>
                    <label class="block text-sm font-medium text-gray-700 mb-2">
                      <i class="fas fa-comments mr-1"></i> 话题 ID（可选，仅用于原位转发）
                    </label>
                    <input id="history-thread-id" type="text" placeholder="例如：123" 
                           class="w-full px-5 py-3 border border-gray-300 rounded-xl focus:border-purple-600 focus:ring-2 focus:ring-purple-200 outline-none">
                    <p class="text-xs text-gray-500 mt-1">如果消息在超级群组的特定话题中，请输入话题ID</p>
                  </div>
                </div>
              </div>

              \${this.state.historyFetching ? \`
                <div class="flex items-center justify-center py-8">
                  <div class="flex items-center gap-3 text-purple-600">
                    <i class="fas fa-spinner fa-spin text-2xl"></i>
                    <span class="text-lg font-medium">正在处理消息...</span>
                  </div>
                </div>
              \` : \`
                <div class="flex justify-end gap-4 pt-6 mt-6 border-t">
                  <button data-close="history" class="px-6 py-3 bg-gray-200 text-gray-700 rounded-xl hover:bg-gray-300 transition">取消</button>
                  <button id="fetch-messages-btn" class="px-6 py-3 bg-gradient-to-r from-purple-500 to-purple-600 text-white rounded-xl hover:shadow-lg transition flex items-center gap-2">
                    <i class="fas fa-play"></i>
                    开始处理
                  </button>
                </div>
              \`}
            </div>
          </div>
        \`;
      }

      bindEvents() {
        document.addEventListener('click', (e) => {
          const target = e.target;
          
          if (target.closest('[data-tab]')) {
            const tab = target.closest('[data-tab]').dataset.tab;
            this.setState({ currentTab: tab });
            if (tab === 'search' || tab === 'admin') {
              this.loadMethods('', '');
            }
            return;
          }
          
          if (target.closest('#mobile-menu-btn')) {
            const menu = document.getElementById('mobile-menu');
            menu.classList.toggle('open');
            return;
          }
          
          if (target.closest('#login-btn')) {
            const password = document.getElementById('admin-password')?.value.trim();
            this.login(password);
            return;
          }
          
          if (target.closest('#mobile-login-btn')) {
            const password = document.getElementById('mobile-password')?.value.trim();
            this.login(password);
            const menu = document.getElementById('mobile-menu');
            menu.classList.remove('open');
            return;
          }
          
          if (target.closest('#logout-btn') || target.closest('#mobile-logout-btn')) {
            this.setState({ showLogoutConfirm: true });
            return;
          }
        });
      }

      bindDynamicEvents() {
        const searchForm = document.getElementById('search-form');
        if (searchForm) {
          searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const input = document.getElementById('search-input');
            if (input) {
              this.setState({ searchQuery: input.value });
              this.loadMethods(input.value, this.state.selectedTag);
            }
          });
        }
        
        document.querySelectorAll('[data-tag]').forEach(btn => {
          btn.addEventListener('click', () => {
            const tag = btn.dataset.tag;
            this.setState({ selectedTag: tag });
            this.loadMethods(this.state.searchQuery, tag);
          });
        });
        
        document.querySelectorAll('[data-bot-tab]').forEach(btn => {
          btn.addEventListener('click', () => {
            const tab = btn.dataset.botTab;
            this.setState({ botTab: tab });
          });
        });
        
        const addMethodBtn = document.getElementById('add-method-btn');
        if (addMethodBtn) {
          addMethodBtn.addEventListener('click', () => {
            this.setState({ editing: null, showModal: true });
          });
        }
        
        const setWebhookBtn = document.getElementById('set-webhook-btn');
        if (setWebhookBtn) {
          setWebhookBtn.addEventListener('click', async () => {
            try {
              const res = await fetch(\`\${this.API_BASE}/set-webhook\`, {
                method: 'POST',
                headers: { 'X-Admin-Key': this.ADMIN_KEY }
              });
              const data = await res.json();
              if (data.success) {
                this.showToast('Webhook 设置成功');
                await this.loadBotInfo();
              } else {
                this.showToast(data.error || '设置失败', true);
              }
            } catch (error) {
              this.showToast('设置失败: ' + error.message, true);
            }
          });
        }
        
        const setCommandsBtn = document.getElementById('set-commands-btn');
        if (setCommandsBtn) {
          setCommandsBtn.addEventListener('click', () => this.setBotCommands());
        }
        
        const saveConfigBtn = document.getElementById('save-config-btn');
        if (saveConfigBtn) {
          saveConfigBtn.addEventListener('click', () => this.saveSystemConfigs());
        }
        
        const saveSettingsBtn = document.getElementById('save-settings-btn');
        if (saveSettingsBtn) {
          saveSettingsBtn.addEventListener('click', () => this.saveSystemConfigs());
        }
        
        const refreshGroupsBtn = document.getElementById('refresh-groups-btn');
        if (refreshGroupsBtn) {
          refreshGroupsBtn.addEventListener('click', () => this.loadGroups());
        }
        
        const validateGroupsBtn = document.getElementById('validate-groups-btn');
        if (validateGroupsBtn) {
          validateGroupsBtn.addEventListener('click', () => this.validateGroups());
        }
        
        this.bindMethodEvents();
        this.bindGroupEvents();
        this.bindModalEvents();
        this.bindConfigEvents();
      }

      bindMethodEvents() {
        document.querySelectorAll('[data-copy]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.copy;
            const method = this.state.methods.find(m => m.id === parseInt(id));
            if (!method) return;
            
            try {
              await navigator.clipboard.writeText(method.code);
              this.showToast('代码已复制！');
            } catch (error) {
              alert('复制失败，请手动选择代码复制');
            }
          });
        });
        
        document.querySelectorAll('[data-verify]').forEach(btn => {
          btn.addEventListener('click', () => {
            const [id, verified] = btn.dataset.verify.split(':');
            this.verifyMethod(parseInt(id), verified === 'true');
          });
        });
        
        document.querySelectorAll('[data-edit]').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.edit;
            const method = this.state.methods.find(m => m.id === parseInt(id));
            if (method) {
              this.setState({ editing: method, showModal: true });
            }
          });
        });
        
        document.querySelectorAll('[data-delete]').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.dataset.delete;
            this.setState({ deletingId: parseInt(id), showDeleteConfirm: true });
          });
        });
      }

      bindGroupEvents() {
        document.querySelectorAll('[data-group-toggle]').forEach(toggle => {
          toggle.addEventListener('change', () => {
            const chatId = toggle.dataset.groupToggle;
            const threadInput = document.getElementById(\`threads_\${chatId.replace(/[^a-zA-Z0-9]/g, '_')}\`);
            const threads = threadInput ? threadInput.value : '';
            this.updateGroup(chatId, toggle.checked, threads);
          });
        });
        
        document.querySelectorAll('[data-group-save]').forEach(btn => {
          btn.addEventListener('click', () => {
            const chatId = btn.dataset.groupSave;
            const toggle = document.querySelector(\`[data-group-toggle="\${chatId}"]\`);
            const threadInput = document.getElementById(\`threads_\${chatId.replace(/[^a-zA-Z0-9]/g, '_')}\`);
            const threads = threadInput ? threadInput.value : '';
            const enabled = toggle ? toggle.checked : false;
            this.updateGroup(chatId, enabled, threads);
          });
        });
        
        document.querySelectorAll('[data-history]').forEach(btn => {
          btn.addEventListener('click', () => {
            const chatId = btn.dataset.history;
            this.setState({ selectedChatId: chatId, showHistoryModal: true });
          });
        });
      }

      bindModalEvents() {
        const saveBtn = document.getElementById('method-save-btn');
        if (saveBtn) {
          saveBtn.addEventListener('click', () => {
            const title = document.getElementById('m-title').value.trim();
            const code = document.getElementById('m-code').value.trim();
            const tags = document.getElementById('m-tags').value.split(',').map(t => t.trim()).filter(t => t);
            const link = document.getElementById('m-link').value.trim();
            
            if (!title || !code) {
              this.showToast('标题和代码不能为空', true);
              return;
            }
            
            const methodData = { title, code, tags, link };
            if (this.state.editing) {
              methodData.id = this.state.editing.id;
            }
            
            this.saveMethod(methodData);
          });
        }
        
        const confirmDeleteBtn = document.getElementById('confirm-delete-btn');
        if (confirmDeleteBtn) {
          confirmDeleteBtn.addEventListener('click', () => {
            if (this.state.deletingId) {
              this.deleteMethod(this.state.deletingId);
            }
          });
        }
        
        const confirmLogoutBtn = document.getElementById('confirm-logout-btn');
        if (confirmLogoutBtn) {
          confirmLogoutBtn.addEventListener('click', () => {
            this.logout();
          });
        }
        
        const fetchMessagesBtn = document.getElementById('fetch-messages-btn');
        if (fetchMessagesBtn) {
          fetchMessagesBtn.addEventListener('click', () => {
            const messageIds = document.getElementById('history-message-ids').value.trim();
            const threadId = document.getElementById('history-thread-id').value.trim();
            this.fetchSpecificMessages(this.state.selectedChatId, messageIds, threadId);
          });
        }
        
        document.querySelectorAll('[data-close]').forEach(btn => {
          btn.addEventListener('click', () => {
            const modal = btn.dataset.close;
            switch (modal) {
              case 'modal':
                this.setState({ showModal: false, editing: null });
                break;
              case 'delete':
                this.setState({ showDeleteConfirm: false, deletingId: null });
                break;
              case 'logout':
                this.setState({ showLogoutConfirm: false });
                break;
              case 'history':
                this.setState({ showHistoryModal: false });
                break;
            }
          });
        });
      }

      bindConfigEvents() {
        document.querySelectorAll('[data-method]').forEach(option => {
          option.addEventListener('click', () => {
            const method = option.dataset.method;
            this.state.systemConfigs.forward_method = method;
            this.setState({ systemConfigs: this.state.systemConfigs });
          });
        });
        
        document.querySelectorAll('[data-api]').forEach(radio => {
          radio.addEventListener('change', () => {
            if (radio.checked) {
              this.state.systemConfigs.forward_api = radio.value;
            }
          });
        });
        
        const autoDelete = document.getElementById('auto-delete');
        if (autoDelete) {
          autoDelete.addEventListener('change', () => {
            this.state.systemConfigs.auto_delete = autoDelete.checked ? '1' : '0';
          });
        }
        
        const shortxRequireVerified = document.getElementById('shortx-require-verified');
        if (shortxRequireVerified) {
          shortxRequireVerified.addEventListener('change', () => {
            this.state.systemConfigs.shortx_require_verified = shortxRequireVerified.checked ? '1' : '0';
          });
        }
        
        const botEnableSearch = document.getElementById('bot-enable-search');
        if (botEnableSearch) {
          botEnableSearch.addEventListener('change', () => {
            this.state.systemConfigs.enable_bot_search = botEnableSearch.checked ? '1' : '0';
          });
        }
        
        const configInputs = ['admin-user-id', 'forward-target', 'forward-thread-id'];
        configInputs.forEach(id => {
          const input = document.getElementById(id);
          if (input) {
            input.addEventListener('input', () => {
              const key = id.replace(/-/g, '_');
              this.state.systemConfigs[key] = input.value;
            });
          }
        });
      }
    }

    document.addEventListener('DOMContentLoaded', () => {
      const app = new ShortXApp();
      window.app = app;
      app.init();
    });
  </script>
</body>
</html>`;
}