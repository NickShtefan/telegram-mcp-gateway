/** Standalone stdio fixture for the client scenario. All Telegram I/O is in memory. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from '../../mcp/server.js';
import { rawChannel, rawMessage } from './fakeTg.js';
import { makeTestGateway } from './gateway.js';

const gw = makeTestGateway();
const channel = rawChannel(500, { username: 'fixture_channel' });
const posts = new Map([[42, 'Original fixture post']]);
gw.tg.on('contacts.ResolveUsername', req => {
  if (req.username !== 'fixture_channel') throw new Error('Unknown fixture channel');
  return { peer: { channelId: 500n }, chats: [channel] };
});
gw.tg.on('channels.GetMessages', req => ({
  chats: [channel],
  messages: req.id.filter((item: { id: number }) => posts.has(item.id))
    .map((item: { id: number }) => rawMessage(500, item.id, { post: true, message: posts.get(item.id) })),
}));
gw.tg.on('messages.SendMessage', req => {
  const id = 42 + posts.size;
  posts.set(id, req.message);
  return { className: 'UpdateShortSentMessage', id };
});
gw.tg.on('messages.EditMessage', req => {
  if (!posts.has(req.id)) throw new Error('Unknown fixture post');
  posts.set(req.id, req.message);
  return { className: 'Updates', updates: [] };
});
const { server } = createMcpServer({ services: gw.services, principal: gw.services.access.principalOf('user_a'),
  toolsets: ['core', 'write'], log: gw.services.runtime.log, version: 'fixture' });
server.server.onclose = () => gw.cleanup();
await server.connect(new StdioServerTransport());
