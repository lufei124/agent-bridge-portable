/**
 * 飞书通道：长连接接收消息 + 应用身份发送消息。
 *
 * 约束（来自官方文档）：
 * - 事件处理必须 3 秒内完成，否则平台超时重推；
 * - 长连接为集群模式，同一应用多开时消息只会被随机一个实例收到；
 * - 仅支持企业自建应用。
 */

import fsp from 'node:fs/promises';
import * as Lark from '@larksuiteoapi/node-sdk';

const RECENT_LIMIT = 500;
// 卡片回调平台要求 3 秒内返回，超过这个耗时就记一条日志，方便定位"转圈圈"
const SLOW_CALLBACK_MS = 800;

export class FeishuChannel {
  constructor({ appId, appSecret, onMessage, onCardAction, loggerLevel = Lark.LoggerLevel.info }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.onMessage = onMessage;
    this.onCardAction = onCardAction;
    this.loggerLevel = loggerLevel;

    this.client = null;
    this.wsClient = null;
    this.messageApi = null;
    this.seen = new Set();
    this.ready = false;
  }

  start() {
    this.client = new Lark.Client({ appId: this.appId, appSecret: this.appSecret });
    this.messageApi = this.client.im?.v1?.message || this.client.im?.message || null;

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: this.loggerLevel,
    });

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        // 不阻塞事件回调：平台要求 3 秒内响应
        this._ingest(data);
      },
      // 卡片交互：返回值会被 SDK 原样送回客户端，用于原地更新卡片
      'card.action.trigger': async (data) => {
        const t0 = Date.now();
        try {
          const payload = data?.event ? data.event : data;
          return (await this.onCardAction?.(payload, data)) || {};
        } catch (err) {
          console.error('[feishu] 卡片回调失败:', err?.message || err);
          return { toast: { type: 'error', content: `处理失败：${err?.message || err}` } };
        } finally {
          const cost = Date.now() - t0;
          if (cost > SLOW_CALLBACK_MS) console.warn(`[feishu] 卡片回调耗时 ${cost}ms`);
        }
      },
    });

    this.wsClient.start({ eventDispatcher });
    this.ready = true;
  }

  async sendText(chatId, text) {
    if (!this.messageApi) throw new Error('飞书 client 尚未初始化');
    return this.messageApi.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: clip(text) }),
      },
    });
  }

  async sendCard(chatId, card) {
    if (!this.messageApi) throw new Error('飞书 client 尚未初始化');
    return this.messageApi.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
  }

  /** 把卡片 Pin 到会话顶部：聊天怎么往下滚，都能一键回到它 */
  async pinMessage(messageId) {
    const api = this.client?.im?.v1?.pin;
    if (!api?.create) return null;
    return api.create({ data: { message_id: messageId } });
  }

  async unpinMessage(messageId) {
    const api = this.client?.im?.v1?.pin;
    if (!api?.delete) return null;
    return api.delete({ path: { message_id: messageId } });
  }

  /** 给消息加个表情回执（只看机器人自己加的那个） */
  async addReaction(messageId, emojiType = 'DONE') {
    const api = this.client?.im?.v1?.messageReaction;
    if (!api?.create) return null;
    return api.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
  }

  /** 把本地图片重新上传到飞书，拿到 image_key 才能显示在卡片里 */
  async uploadImage(buffer) {
    const api = this.client?.im?.v1?.image;
    if (!api?.create) throw new Error('当前 SDK 不支持上传图片');
    const res = await api.create({ data: { image_type: 'message', image: buffer } });
    return res?.data?.image_key || res?.image_key || '';
  }

  /** 撤回机器人自己发的消息（用来清掉已经不再更新的旧卡片） */
  async deleteMessage(messageId) {
    if (!this.messageApi?.delete) return null;
    return this.messageApi.delete({ path: { message_id: messageId } });
  }

  /** 更新已发送的卡片（用于异步刷新，不能用于回调响应） */
  async patchCard(messageId, card) {
    if (!this.messageApi) throw new Error('飞书 client 尚未初始化');
    return this.messageApi.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  }

  /**
   * 应用内加急：让客户端弹窗并响铃，但不会在会话里产生新消息。
   *
   * 限制（官方文档）：
   * - 只能加急机器人自己发出的消息；
   * - 需要 im:message.urgent 权限；
   * - 对方未读的加急消息累计不能超过 200 条。
   */
  async urgentApp(messageId, openIds) {
    if (!this.messageApi?.urgentApp) throw new Error('当前 SDK 不支持加急接口');
    return this.messageApi.urgentApp({
      path: { message_id: messageId },
      params: { user_id_type: 'open_id' },
      data: { user_id_list: openIds },
    });
  }

  /**
   * 下载消息里的图片 / 文件。
   *
   * 飞书不给我们直接的 URL，只能拿 message_id + file_key 换二进制。
   * SDK 的响应对象自带 writeFile()，一次落盘，不用经过内存。
   */
  async downloadAttachment(messageId, media, dest) {
    const api = this.client?.im?.v1?.messageResource;
    if (!api?.get) throw new Error('当前 SDK 不支持下载消息资源');

    let resp;
    try {
      resp = await api.get({
        path: { message_id: messageId, file_key: media.key },
        params: { type: media.type === 'image' ? 'image' : 'file' },
      });
    } catch (err) {
      throw new Error(await describeFeishuError(err));
    }

    if (typeof resp?.writeFile === 'function') {
      await resp.writeFile(dest);
      return dest;
    }
    const buf = Buffer.isBuffer(resp) ? resp : resp?.data;
    if (Buffer.isBuffer(buf)) {
      await fsp.writeFile(dest, buf);
      return dest;
    }
    throw new Error('下载失败：未知的响应类型');
  }

  _ingest(data) {
    try {
      const message = data?.message;
      const sender = data?.sender;
      if (!message || !sender) return;

      // 忽略机器人自己发的消息，避免自问自答
      if (sender.sender_type === 'app' || sender.sender_type === 'bot') return;

      // 平台会重推未及时确认的事件，按 message_id 去重
      if (this.seen.has(message.message_id)) return;
      this.seen.add(message.message_id);
      if (this.seen.size > RECENT_LIMIT) {
        this.seen.delete(this.seen.values().next().value);
      }

      const { text, media } = parseContent(message);
      // 纯文字、或者带附件（附件可以没有配文）都要放行
      if (!text && !media) return;

      const payload = {
        chatId: message.chat_id,
        chatType: message.chat_type,
        messageId: message.message_id,
        openId: sender.sender_id?.open_id,
        text,
        media,
        raw: message,
      };

      Promise.resolve(this.onMessage(payload)).catch((err) => {
        console.error('[feishu] 处理消息失败:', err?.message || err);
      });
    } catch (err) {
      console.error('[feishu] 事件解析失败:', err?.message || err);
    }
  }
}

/**
 * 把飞书消息拆成「文字 + 可选附件」。
 *
 * 支持 text / image / file 三种；其它类型（语音、视频、富文本 post）暂时忽略，
 * 免得把解析不了的东西当成空消息吞掉。
 */
function parseContent(message) {
  let content;
  try {
    content = JSON.parse(message.content || '{}');
  } catch {
    return { text: '' };
  }

  const type = message.message_type || 'text';

  if (type === 'image') {
    return content.image_key
      ? { text: '', media: { type: 'image', key: content.image_key } }
      : { text: '' };
  }

  if (type === 'file') {
    return content.file_key
      ? {
          text: '',
          media: { type: 'file', key: content.file_key, name: content.file_name || '' },
        }
      : { text: '' };
  }

  if (type !== 'text') return { text: '' };

  // 群聊里 @机器人：内容里可能是 <at ...>名字</at>，也可能只是 @_user_1 占位符
  const text = String(content.text || '')
    .replace(/<at[^>]*>.*?<\/at>/g, '')
    .replace(/@_user_\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { text };
}

function clip(text, max = 28000) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 把飞书 SDK 的错误翻译成人话。
 *
 * 错误体是个 stream，得先读出来再 parse；拿不到就退回原始 message。
 * 这里专门识别最常见的两个：缺权限、缺参数。
 */
async function describeFeishuError(err) {
  const stream = err?.response?.data;
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    try {
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      if (body.code === 99991672) {
        return '应用缺少「获取消息」权限（im:message）。去飞书开发者后台 → 权限管理加这个权限，再发版。';
      }
      if (body.code === 99992402) {
        const fields = body.error?.field_violations?.map((f) => f.field).join('、');
        return `请求参数不对${fields ? `：${fields}` : ''}。`;
      }
      if (body.msg) return `飞书错误 ${body.code}: ${body.msg}`;
    } catch {
      /* 读不出错误体，退回原始 message */
    }
  }
  return `下载失败：${err?.message || err}`;
}
