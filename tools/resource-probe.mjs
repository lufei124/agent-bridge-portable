/**
 * 复现飞书「获取消息资源」400 错误，打印真实错误码。
 *
 *   node --env-file-if-exists=.env tools/resource-probe.mjs <message_id> <file_key> <type>
 */
import * as Lark from '@larksuiteoapi/node-sdk';

const [, , messageId, fileKey, type] = process.argv;
if (!messageId || !fileKey) {
  console.error('用法: node tools/resource-probe.mjs <message_id> <file_key> [image|file]');
  process.exit(1);
}

const client = new Lark.Client({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
});

const api = client.im?.v1?.messageResource;
if (!api?.get) {
  console.error('SDK 没有 messageResource.get');
  process.exit(1);
}

for (const t of [type, 'image', 'file', undefined]) {
  try {
    const resp = await api.get({
      path: { message_id: messageId, file_key: fileKey },
      ...(t ? { params: { type: t } } : {}),
    });
    console.log(`type=${t ?? '(不传)'} ✅ 成功，headers:`);
    console.log(resp.headers);
    process.exit(0);
  } catch (err) {
    const body = await readErrorBody(err);
    console.log(`type=${t ?? '(不传)'} ❌ ${err?.message} -> ${body}`);
  }
}

async function readErrorBody(err) {
  const stream = err?.response?.data;
  if (!stream) return '(无响应体)';
  try {
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  } catch (e) {
    return `(读响应体失败: ${e?.message})`;
  }
}
