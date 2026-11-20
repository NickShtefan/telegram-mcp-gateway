/** Standalone stdio fixture for the client scenario. All Telegram I/O is in memory. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Api } from 'teleproto';
import bigInt from 'big-integer';
import { writeFileSync } from 'node:fs';
import { startHttpServer } from '../../transport/http.js';
import { createMcpServer } from '../../mcp/server.js';
import { rawChannel, rawMessage } from './fakeTg.js';
import { makeTestGateway } from './gateway.js';

const gw = makeTestGateway();
const channel = rawChannel(500, { username: 'fixture_channel' });
const posts = new Map([[42, rawMessage(500, 42, { post: true, message: 'Original fixture post' })],
  [41, rawMessage(500, 41, { post: true, message: '  Read our channel 👩‍💻  ', entities: [
    new Api.MessageEntityTextUrl({ offset: 11, length: 7, url: 'https://t.me/fixture_old' }),
    new Api.MessageEntityBold({ offset: 11, length: 7 }),
  ] })], [40, rawMessage(500,40,{post:true,message:'Read alpha or beta.',entities:[
    new Api.MessageEntityTextUrl({offset:5,length:5,url:'https://example.org/first'}),
    new Api.MessageEntityTextUrl({offset:14,length:4,url:'https://example.org/second'}),
    new Api.MessageEntityBold({offset:14,length:4}),
  ]})]]);
function fixtureCard(url: string, manual = false, forceSmallMedia = false, forceLargeMedia = false) {
  return new Api.MessageMediaWebPage({manual,forceSmallMedia,forceLargeMedia,webpage:new Api.WebPage({
    id:bigInt(40),hash:0,url,displayUrl:url,hasLargeMedia:true,
  })});
}
gw.tg.on('contacts.ResolveUsername', req => {
  if (req.username !== 'fixture_channel') throw new Error('Unknown fixture channel');
  return { peer: { channelId: 500n }, chats: [channel] };
});
gw.tg.on('channels.GetMessages', req => ({
  chats: [channel],
  messages: req.id.filter((item: { id: number }) => posts.has(item.id))
    .map((item: { id: number }) => posts.get(item.id)),
}));
gw.tg.on('channels.GetParticipant', () => ({ participant: { className: 'ChannelParticipantCreator' } }));
gw.tg.on('help.GetConfig', () => ({ messageLengthMax: 4096, captionLengthMax: 1024 }));
gw.tg.on('messages.GetWebPagePreview', req => ({media:fixtureCard(req.message)}));
gw.tg.on('messages.SendMessage', req => {
  const id = 42 + posts.size;
  posts.set(id, rawMessage(500, id, { post: true, message: req.message }));
  return { className: 'UpdateShortSentMessage', id };
});
gw.tg.on('messages.EditMessage', req => {
  const post = posts.get(req.id);
  if (!post) throw new Error('Unknown fixture post');
  post.message = req.message;
  post.entities = req.entities;
  if (req.noWebpage) post.media = undefined;
  else if (req.media?.className === 'InputMediaWebPage') {
    post.media = fixtureCard(req.media.url, true, req.media.forceSmallMedia, req.media.forceLargeMedia);
  }
  post.invertMedia = !!req.invertMedia;
  return { className: 'Updates', updates: [] };
});
const options = { services: gw.services, toolsets: ['core', 'write'], log: gw.services.runtime.log, version: 'fixture' };
if (process.argv[2] === '--http-config') {
  // Two CLI invocations can share the synthetic approval store. Never load real gateway state.
  const server = await startHttpServer({ ...options, host: '127.0.0.1', port: 0 });
  const config = { mcpServers: { fixture: { type: 'http', url: `http://127.0.0.1:${server.port}/mcp`,
    headers: { Authorization: 'Bearer ' + gw.tokens.user_a } } } };
  writeFileSync(process.argv[3], JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  process.once('SIGTERM', async () => { await server.close(); gw.cleanup(); });
} else {
  const { server } = createMcpServer({ ...options, principal: gw.services.access.principalOf('user_a') });
  server.server.onclose = () => gw.cleanup();
  await server.connect(new StdioServerTransport());
}
