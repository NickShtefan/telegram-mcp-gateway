/**
 * Composes services over core. Services have no MCP or transport dependencies;
 * tools and tool-started jobs (export, indexing) call them.
 */
import { buildWriteGate, type WriteGate } from '../writegate/index.js';
import { AccessPolicy } from '../policy/access.js';
import { Audit } from '../policy/audit.js';
import { ScopePolicy } from '../policy/scopes.js';
import type { Runtime } from '../runtime.js';
import { CommentsService } from './comments.js';
import { DialogsService } from './dialogs.js';
import { DiscoverService } from './discover.js';
import { ExportService } from './export.js';
import { HistoryService } from './history.js';
import { JobManager } from './jobs.js';
import { IndexStore, LocalIndexService } from './localIndex.js';
import { MediaService } from './media.js';
import { Resolver } from './resolve.js';
import { SearchService } from './search.js';
import { SnapshotStore, StatsService } from './stats.js';
import { GatewayError } from '../core/errors.js';
import { SharedFiles } from '../core/safeFs.js';
import type { DirectoryAttestor } from '../core/windowsAcl.js';
import { SqliteStorage } from '../storage/sqlite.js';
import { TopicsService } from './topics.js';

export interface GatewayServices {
  runtime: Runtime;
  access: AccessPolicy;
  scopes: ScopePolicy;
  audit: Audit;
  resolver: Resolver;
  history: HistoryService;
  search: SearchService;
  comments: CommentsService;
  dialogs: DialogsService;
  discover: DiscoverService;
  stats: StatsService;
  snapshots: SnapshotStore;
  localIndex: LocalIndexService;
  indexStore: IndexStore;
  topics: TopicsService;
  media: MediaService;
  /** Shared files directory guard for exports and media, one per process. */
  files: SharedFiles;
  jobs: JobManager;
  writeGate: WriteGate;
}

export interface BuildOptions {
  now?: () => number;
  /** Windows ACL check of the shared files directories; defaults to the fixed PowerShell helper. */
  attestDirectories?: DirectoryAttestor;
}

export function buildServices(runtime: Runtime, options: BuildOptions = {}): GatewayServices {
  const now = options.now ?? (() => Date.now());
  const { tg, storage, config, log } = runtime;
  const history = new HistoryService(tg);
  const search = new SearchService(tg, storage.entities);
  const files = new SharedFiles(config.filesDir, { attest: options.attestDirectories });
  const media = new MediaService({ tg, files, log: log.child('media'), now });
  const exporter = new ExportService({ storage, history, search, media, files, now });
  const jobs = new JobManager({ storage, log: log.child('jobs') });
  jobs.register('export', context => exporter.run(context));

  const comments = new CommentsService(tg, storage.entities);
  const writeGate = buildWriteGate({ runtime, comments, history, now });
  if (!(storage instanceof SqliteStorage)) throw new GatewayError('UNAVAILABLE', 'The gateway needs the SQLite storage.');
  const resolver = new Resolver({ tg, entities: storage.entities, now });
  const snapshots = new SnapshotStore(storage, now);
  const indexStore = new IndexStore(storage, now);
  const localIndex = new LocalIndexService({ storage, store: indexStore, history, now });
  jobs.register('index', context => localIndex.run(context));

  return {
    runtime,
    access: new AccessPolicy(storage),
    scopes: new ScopePolicy(storage),
    audit: new Audit(storage, now, log.child('audit')),
    resolver,
    history,
    search,
    comments,
    dialogs: new DialogsService(tg, storage.entities),
    discover: new DiscoverService(tg, storage.entities, history),
    stats: new StatsService({ history, resolver, snapshots, now }),
    snapshots,
    localIndex,
    indexStore,
    topics: new TopicsService(tg),
    media,
    files,
    jobs,
    writeGate,
  };
}
