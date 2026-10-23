/** Canonical signed release metadata. No npm/Telegram/config dependencies before extraction. */
import { createHash, constants, verify, X509Certificate } from 'node:crypto';

export const ARTIFACT_ROLES = ['node', 'installer', 'manifest_helper', 'archive_helper', 'application', 'node_license'] as const;
export type ArtifactRole = typeof ARTIFACT_ROLES[number];
export type InstallPlatform = 'darwin' | 'linux' | 'win32';
export type InstallArchitecture = 'arm64' | 'x64';
export interface Artifact { role: ArtifactRole; name: string; size: number; sha256: string; }
export interface ReleaseManifest {
  version: string; sourceSha: string; platform: InstallPlatform; architecture: InstallArchitecture;
  nodeVersion: string; artifacts: Artifact[];
}
export interface TrustPolicy {
  signerSha256: string; version: string; sourceSha: string; platform: InstallPlatform; architecture: InstallArchitecture;
}
export class ArtifactError extends Error {
  constructor(readonly code: 'invalid_manifest' | 'untrusted_signer' | 'invalid_signature' | 'wrong_release' | 'wrong_platform' | 'artifact_mismatch') { super(code); }
}
const names: Record<ArtifactRole, string> = {
  node: 'node', installer: 'installer.mjs', manifest_helper: 'manifest.mjs', archive_helper: 'archive.mjs',
  application: 'application.tar.gz', node_license: 'NODE_LICENSE',
};
const sha = /^[0-9a-f]{64}$/;
const version = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
function invalid(): never { throw new ArtifactError('invalid_manifest'); }

export function encodeManifest(value: ReleaseManifest): Buffer {
  const lines = [
    'TG_MCP_RELEASE_V1', `version\t${value.version}`, `source_sha\t${value.sourceSha}`,
    `platform\t${value.platform}`, `architecture\t${value.architecture}`, `node_version\t${value.nodeVersion}`,
    ...value.artifacts.map(a => `file\t${a.role}\t${a.name}\t${a.size}\t${a.sha256}`),
  ];
  const bytes = Buffer.from(lines.join('\n') + '\n', 'ascii');
  parseManifest(bytes);
  return bytes;
}

export function parseManifest(bytes: Buffer): ReleaseManifest {
  if (bytes.length > 8192 || bytes.length === 0 || bytes.some(b => b > 127 || (b < 32 && b !== 9 && b !== 10))) invalid();
  const lines = bytes.toString('ascii').split('\n');
  if (lines.pop() !== '' || lines.length !== 6 + ARTIFACT_ROLES.length || lines[0] !== 'TG_MCP_RELEASE_V1') invalid();
  const field = (index: number, key: string): string => {
    const cells = lines[index]!.split('\t');
    if (cells.length !== 2 || cells[0] !== key) invalid();
    return cells[1]!;
  };
  const releaseVersion = field(1, 'version'); const sourceSha = field(2, 'source_sha');
  const platform = field(3, 'platform'); const architecture = field(4, 'architecture'); const nodeVersion = field(5, 'node_version');
  if (!version.test(releaseVersion) || !/^[0-9a-f]{40}$/.test(sourceSha) || !version.test(nodeVersion)) invalid();
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(architecture)) invalid();
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!((major === 22 && minor! >= 13) || major === 24)) invalid();
  const artifacts = ARTIFACT_ROLES.map((role, i): Artifact => {
    const fields = lines[i + 6]!.split('\t');
    const name = role === 'node' && platform === 'win32' ? 'node.exe' : names[role];
    if (fields.length !== 5 || fields[0] !== 'file' || fields[1] !== role || fields[2] !== name
      || !/^[1-9]\d{0,8}$/.test(fields[3]!) || !sha.test(fields[4]!)) invalid();
    const size = Number(fields[3]);
    const maximum = role === 'node' || role === 'application' ? 134_217_728 : 1_048_576;
    if (size > maximum) invalid();
    return { role, name, size, sha256: fields[4]! };
  });
  return { version: releaseVersion, sourceSha, platform: platform as InstallPlatform, architecture: architecture as InstallArchitecture, nodeVersion, artifacts };
}

/** Pin the independently supplied DER certificate digest before using its public key. */
export function verifyManifest(bytes: Buffer, signature: Buffer, certificate: Buffer, policy: TrustPolicy): ReleaseManifest {
  if (!sha.test(policy.signerSha256) || certificate.length > 16_384 || signature.length !== 384) throw new ArtifactError('untrusted_signer');
  if (createHash('sha256').update(certificate).digest('hex') !== policy.signerSha256) throw new ArtifactError('untrusted_signer');
  let signer: X509Certificate;
  try { signer = new X509Certificate(certificate); } catch { throw new ArtifactError('untrusted_signer'); }
  if (!signer.raw.equals(certificate)) throw new ArtifactError('untrusted_signer');
  if (signer.publicKey.asymmetricKeyType !== 'rsa' || signer.publicKey.asymmetricKeyDetails?.modulusLength !== 3072) throw new ArtifactError('untrusted_signer');
  if (bytes.length > 8192 || !verify('sha256', bytes, { key: signer.publicKey, padding: constants.RSA_PKCS1_PADDING }, signature)) throw new ArtifactError('invalid_signature');
  const manifest = parseManifest(bytes);
  if (manifest.version !== policy.version || manifest.sourceSha !== policy.sourceSha) throw new ArtifactError('wrong_release');
  if (manifest.platform !== policy.platform || manifest.architecture !== policy.architecture) throw new ArtifactError('wrong_platform');
  return manifest;
}

export function verifyArtifact(artifact: Artifact, bytes: Buffer): void {
  if (bytes.length !== artifact.size || createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new ArtifactError('artifact_mismatch');
}
