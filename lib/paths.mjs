import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 参考实现的仓库根目录（lib/ 的上一级）。 */
export const DEFAULT_ROOT = path.resolve(MODULE_DIR, '..');

/** 由根目录推导各存储位置。 */
export function makePaths(root) {
  return {
    root,
    repos: path.join(root, 'repos'),
    workspaces: path.join(root, 'workspaces'),
    packages: path.join(root, 'packages'),
    state: path.join(root, 'state'),
    latest: path.join(root, 'latest.noml'),
    stateFile: path.join(root, 'state', 'sync.noml'),
  };
}
