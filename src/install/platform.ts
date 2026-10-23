/** Fixed installation profiles. Never accept caller-supplied administrator paths or commands. */
import { posix, win32 } from 'node:path';
import type { InstallPlatform } from './manifest.js';

export interface InstallLayout {
  platform: InstallPlatform; service: string; account: string;
  prefix: string; release: string; node: string; application: string;
  state: string; files: string; logs: string; definition: string;
}
export function installLayout(platform: InstallPlatform, sourceSha: string): InstallLayout {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('invalid_installation_plan');
  if (platform === 'darwin') {
    const prefix = '/Library/Application Support/TelegramMCPGateway'; const release = posix.join(prefix, 'releases', sourceSha);
    return { platform, service: 'io.telegram-mcp-gateway', account: '_tgmcp', prefix, release,
      node: posix.join(release, 'node'), application: posix.join(release, 'application'),
      state: posix.join(prefix, 'state'), files: posix.join(prefix, 'files'), logs: posix.join(prefix, 'logs'),
      definition: '/Library/LaunchDaemons/io.telegram-mcp-gateway.plist' };
  }
  if (platform === 'linux') {
    const prefix = '/opt/telegram-mcp-gateway'; const release = posix.join(prefix, 'releases', sourceSha);
    return { platform, service: 'telegram-mcp-gateway', account: 'telegram-mcp-gateway', prefix, release,
      node: posix.join(release, 'node'), application: posix.join(release, 'application'),
      state: '/var/lib/telegram-mcp-gateway', files: posix.join(prefix, 'files'), logs: '/var/log/telegram-mcp-gateway',
      definition: '/etc/systemd/system/telegram-mcp-gateway.service' };
  }
  if (platform === 'win32') {
    const prefix = 'C:\\ProgramData\\TelegramMCPGateway'; const release = win32.join(prefix, 'releases', sourceSha);
    return { platform, service: 'TelegramMCPGateway', account: 'NT SERVICE\\TelegramMCPGateway', prefix, release,
      node: win32.join(release, 'node.exe'), application: win32.join(release, 'application'),
      state: win32.join(prefix, 'state'), files: win32.join(prefix, 'files'), logs: win32.join(prefix, 'logs'),
      definition: win32.join(prefix, 'service.json') };
  }
  throw new Error('unsupported_platform');
}
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function serviceDefinition(layout: InstallLayout, port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_installation_plan');
  // Reconstruct to reject forged layouts from an untyped caller.
  const sha = (layout.platform === 'win32' ? win32 : posix).basename(layout.release);
  if (JSON.stringify(layout) !== JSON.stringify(installLayout(layout.platform, sha))) throw new Error('invalid_installation_plan');
  if (layout.platform === 'darwin') {
    const arguments_ = [layout.node, posix.join(layout.application, 'dist/cli/index.js'), 'serve', '--host', '127.0.0.1', '--port', String(port), '--toolsets', 'core', '--files-dir', layout.files];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${layout.service}</string><key>UserName</key><string>${layout.account}</string><key>GroupName</key><string>${layout.account}</string>
<key>ProgramArguments</key><array>${arguments_.map(a => `<string>${xml(a)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>TG_MCP_HOME</key><string>${xml(layout.state)}</string><key>PATH</key><string>/usr/bin:/bin</string></dict>
<key>WorkingDirectory</key><string>${xml(layout.release)}</string><key>RunAtLoad</key><false/><key>Disabled</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>3</integer>
<key>StandardOutPath</key><string>${xml(posix.join(layout.logs, 'stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(posix.join(layout.logs, 'stderr.log'))}</string>
</dict></plist>\n`;
  }
  if (layout.platform === 'linux') return `[Unit]\nDescription=Unofficial Telegram MCP Gateway\nAfter=network-online.target\nWants=network-online.target\n
[Service]\nType=simple\nUser=${layout.account}\nGroup=${layout.account}\nWorkingDirectory=${layout.release}
Environment=TG_MCP_HOME=${layout.state}\nEnvironment=PATH=/usr/bin:/bin
ExecStart=${layout.node} ${layout.application}/dist/cli/index.js serve --host 127.0.0.1 --port ${port} --toolsets core --files-dir ${layout.files}
Restart=on-failure\nRestartSec=3\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict
ReadWritePaths=${layout.state} ${layout.files} ${layout.logs}\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n
[Install]\nWantedBy=multi-user.target\n`;
  return JSON.stringify({ format_version: 1, service: layout.service, account: layout.account,
    node: layout.node, entry: win32.join(layout.application, 'dist/cli/index.js'), state: layout.state, files: layout.files, logs: layout.logs, port, toolsets: 'core' }) + '\n';
}
