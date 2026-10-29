// OneBot 11 HTTP 传输层：把它换成 Netscape 以外的假 fetch，验证「发现聊天 → 拉历史 → 去重 → 跳过自己」。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOneBotHttpTransport } from '../src/ecosystem/qq-native/onebot-http.ts';

const ok = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok', retcode: 0, data }),
}) as unknown as Response;

test('OneBot HTTP：自动发现聊天、按时间递新消息、跳过她自己发的、发送带 token', async t => {
  const realFetch = globalThis.fetch;
  const now = Math.floor(Date.now() / 1000);
  const calls: string[] = [];
  const seen: any[] = [];

  globalThis.fetch = (async (url: string, init: any) => {
    const action = String(url).split('/').pop()!;
    calls.push(action);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer tok');
    switch (action) {
      case 'get_login_info': return ok({ user_id: 2039693365, nickname: '大肥鱼' });
      case 'get_group_list': return ok([{ group_id: 681528723, group_name: '小团体' }]);
      case 'get_friend_list': return ok([{ user_id: 3475994805, nickname: '老大' }]);
      case 'get_recent_contact':
        return ok([{ peerUin: '3475994805', peerName: '老大', msgTime: String(now), chatType: 1 }]);
      case 'get_group_msg_history':
        return ok({
          messages: [
            {
              message_id: 501, message_type: 'group', group_id: 681528723, time: now + 2,
              sender: { user_id: 3475994805, nickname: '老大' },
              message: [{ type: 'at', data: { qq: '2039693365' } }, { type: 'text', data: { text: ' 帮忙看下' } }],
            },
            {
              message_id: 502, message_type: 'group', group_id: 681528723, time: now + 3,
              sender: { user_id: 2039693365 },
              message: [{ type: 'text', data: { text: '我自己发的' } }],
            },
          ],
        });
      case 'get_friend_msg_history':
        return ok({
          messages: [{
            message_id: 601, message_type: 'private', time: now + 2,
            sender: { user_id: 3475994805, nickname: '老大' },
            message: [{ type: 'text', data: { text: '在吗' } }],
          }],
        });
      case 'send_private_msg': return ok({ message_id: 701 });
      default: return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }
  }) as any;
  t.after(() => { globalThis.fetch = realFetch; });

  const transport = createOneBotHttpTransport({
    wsUrl: '',
    baseUrl: 'http://127.0.0.1:3000',
    accessToken: 'tok',
    pollIntervalMs: 500,
    discoverIntervalMs: 1000,
    log: () => {},
    onGroupMessage: message => seen.push({ kind: 'group', ...(message as Record<string, unknown>) }),
    onPrivateMessage: message => seen.push({ kind: 'private', ...(message as Record<string, unknown>) }),
  });
  await transport.start();
  t.after(() => transport.stop());

  const deadline = Date.now() + 5_000;
  while (seen.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(transport.getState(), 'online', '拿一次 get_login_info 就算连上了');
  assert.ok(calls.includes('get_recent_contact'), '用最近会话发现聊天，不靠手填名单');

  const priv = seen.find(message => message.kind === 'private');
  assert.ok(priv, '私聊消息应该递上来');
  assert.equal(priv.userId, '3475994805');
  assert.equal(priv.text, '在吗');
  assert.equal(priv.selfId, '2039693365');

  const group = seen.find(message => message.kind === 'group');
  assert.ok(group, '群消息也应该递上来');
  assert.equal(group.groupId, '681528723');
  assert.equal(group.text, '@2039693365 帮忙看下');
  assert.ok(!seen.some(message => message.messageId === '502'), '她自己发的那条不能当新消息');

  const sent = await transport.sendPrivate('3475994805', '在的');
  assert.equal(sent.messageId, '701');
  assert.equal(calls[calls.length - 1], 'send_private_msg');
});
