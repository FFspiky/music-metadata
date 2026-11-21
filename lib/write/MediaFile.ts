import { resolve } from 'node:path';
import { parseFile } from '../parseFile.js';
import type { IAudioMetadata, IOptions } from '../type.js';
import { WriteError } from './core/errors.js';
import type { TagPatch, WriteOptions, WriteResult } from './core/types.js';
import { FileTagSnapshot, writeFileTags } from './file.js';

/** A local audio file and its parsed metadata. Edit metadata.common before saving. */
export class MediaFile {
  private snapshot: FileTagSnapshot;
  /** Set when a committed patch could not be reloaded; the metadata no longer matches the file. */
  private reloadError: unknown;
  /** Writes and reloads run one at a time, so none can act on metadata another is replacing. */
  private pending: Promise<unknown> | undefined;

  private constructor(
    private readonly filePath: string,
    private parsed: IAudioMetadata,
    private readonly options?: IOptions
  ) {
    this.snapshot = new FileTagSnapshot(this.parsed.common);
  }

  get metadata(): IAudioMetadata {
    return this.parsed;
  }

  /**
   * Write only the supplied common and native fields. On success, reload the metadata from disk.
   * If the write commits but the reload fails, the result is still returned and save() rejects
   * until reload() succeeds.
   */
  applyPatch(patch: TagPatch, options?: WriteOptions): Promise<WriteResult> {
    return this.serialize(async () => {
      const result = await writeFileTags(this.filePath, patch, options);
      if (!options?.dryRun) {
        try {
          await this.refresh();
        } catch (error) {
          this.reloadError = error;
        }
      }
      return result;
    });
  }

  /** Re-read the metadata from disk, discarding unsaved in-memory edits. */
  reload(): Promise<void> {
    return this.serialize(() => this.refresh());
  }

  private async refresh(): Promise<void> {
    const refreshed = await MediaFile.open(this.filePath, this.options);
    this.parsed = refreshed.metadata;
    this.snapshot = refreshed.snapshot;
    this.reloadError = undefined;
  }

  /** Start at once when idle, so save() captures the common tags at the call, as before. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.pending ? this.pending.then(task, task) : task();
    const pending = result.catch(() => undefined);
    this.pending = pending;
    void pending.then(() => {
      if (this.pending === pending) {
        this.pending = undefined;
      }
    });
    return result;
  }

  static async open(filePath: string, options?: IOptions): Promise<MediaFile> {
    const path = resolve(filePath);
    return new MediaFile(path, await parseFile(path, options), options);
  }

  /** Apply the current common tags as a patch to the original file. */
  save(options?: WriteOptions): Promise<WriteResult> {
    const common = this.parsed.common;
    return this.serialize(async () => {
      if (this.parsed.common !== common) {
        throw new WriteError(
          'MediaFile metadata was reloaded before this save; edits to the old metadata were not saved'
        );
      }
      if (this.reloadError !== undefined) {
        throw new WriteError('MediaFile metadata is stale after a patch; call reload() before saving', {
          cause: this.reloadError
        });
      }
      return writeFileTags(this.filePath, this.metadata.common, options, this.snapshot);
    });
  }
}
