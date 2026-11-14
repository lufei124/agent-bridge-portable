export const DEEPSEEK_PRESET_REASON = '此 DeepSeek 会话使用电脑端预设，请在电脑上继续。';

export function explainFailure(text, platform) {
  const value = String(text || '');
  if (platform === 'codex' && /already has an active writer/i.test(value)) {
    return { title: 'Codex 会话正由电脑端使用', detail: '请在电脑上关闭这个 Codex 会话，再重发。', retry: true };
  }
  if (platform === 'deepseek' && /session\/writer-held|SessionAlreadyOwnedError/i.test(value)) {
    return { title: 'DeepSeek 会话正在使用', detail: '请先在电脑端关闭原会话或等当前一轮结束，再从飞书重发。', retry: true };
  }
  if (platform === 'deepseek' && /session\/not-found/.test(value)) {
    return { title: '找不到这条 DeepSeek 会话', detail: '请确认桥接和电脑端使用同一 Harness 会话目录，然后在飞书重新打开原会话。', retry: false };
  }
  if (platform === 'deepseek' && /DSH_WEB_INPUT_REQUIRED/.test(value)) {
    return { title: 'DeepSeek 此轮需要电脑端确认', detail: '这条消息已交给原会话。请在电脑端打开同一会话继续。', retry: false };
  }
  if (platform === 'deepseek' && /DSH_WEB_(?:REPLY_UNCONFIRMED|PROMPT_UNCONFIRMED|TURN_TIMEOUT)/.test(value)) {
    return { title: 'DeepSeek 本轮结果未确认', detail: '请先打开原会话查看消息和回复，再决定是否重试。', retry: false };
  }
  if (platform === 'deepseek' && /DSH_WEB_START/.test(value) && /\b(?:EPERM|EACCES)\b|access is denied|拒绝访问/i.test(value)) {
    return { title: 'Windows 拒绝写入 DeepSeek 配置', detail: 'DeepSeek 本机会话服务未能更新配置。恢复配置目录的写入权限后，可重发这条消息。', retry: true };
  }
  if (platform === 'deepseek' && /DSH_WEB_START/.test(value) && /\b(?:ENOENT|EINVAL)\b/.test(value)) {
    return { title: '桥接未能启动 DeepSeek CLI', detail: '请检查桥接能否找到 dsh 和 Node.js，再重发。', retry: true };
  }
  if (platform === 'deepseek' && /DSH_WEB_(?:START|AUTH)/.test(value)) {
    return { title: 'DeepSeek 本机会话服务未就绪', detail: '请检查电脑端 DeepSeek Harness 是否能正常打开会话和读取设置，再重试。', retry: true };
  }
  if (platform === 'deepseek' && /MISSING_CREDENTIAL|no API key for provider route/i.test(value)) {
    return { title: '桥接未读到 DeepSeek API Key', detail: '请确认电脑的 DeepSeek 模型提供商已保存 API Key，并与桥接使用同一个 Harness 配置目录。', retry: true };
  }
  if (platform === 'deepseek' && /ACCOUNT_SIGN_IN_REQUIRED|ACCOUNT_TOKEN_INVALID/.test(value)) {
    return { title: 'DeepSeek 账号需要重新登录', detail: '请在电脑端检查 DeepSeek 账号登录状态，然后打开原会话。', retry: true };
  }
  if (platform === 'codex' && /no rollout found for thread id/i.test(value)) {
    return { title: '找不到 Codex 会话记录', detail: '请在电脑上确认这条会话仍可打开，再到飞书重新选择。', retry: false };
  }
  if (platform === 'deepseek' && /runs under agent preset "[^"]+", which the one-shot runner does not compose/i.test(value)) {
    return { detail: DEEPSEEK_PRESET_REASON, retry: false };
  }
  if (/rate.?limit|\b429\b|overloaded/i.test(value)) {
    return { detail: '模型服务繁忙，请稍后重发。', retry: true };
  }
  if (/quota|credit|usage limit|insufficient/i.test(value)) {
    return { detail: '服务额度可能已用完，请检查对应平台的用量。', retry: true };
  }
  if (/\b401\b|unauthorized|invalid api key|not logged in/i.test(value)) {
    const app = { 'claude-code': 'Claude', codex: 'Codex', deepseek: 'DeepSeek' }[platform];
    return { detail: `身份验证失败，请在电脑上检查 ${app || '对应平台'} 的登录或 API 配置。`, retry: true };
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|fetch failed|network/i.test(value)) {
    return { detail: '连接失败，请检查电脑的网络或代理后再试。', retry: true };
  }
  return { detail: '电脑端执行失败，请检查对应平台的运行状态后再试。', retry: true };
}
