/**
 * 上游仓库 raw 文件抓取。
 *
 * 默认走 HTTP；测试时可注入自定义 fetchText，便于离线端到端验证。
 */

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export function isNotFound(err) {
  return err instanceof HttpError && err.status === 404;
}

async function defaultFetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'nohub-sync' },
    redirect: 'follow',
  });
  if (!res.ok) throw new HttpError(res.status, url);
  return res.text();
}

/** 由托管主机、作者、仓库、ref 与仓库相对路径拼出 raw 地址。 */
export function rawUrl(host, owner, repo, ref, repoPath) {
  const p = String(repoPath).replace(/^\/+/, '');
  if (host === 'github.com') {
    return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`;
  }
  return `https://${host}/${owner}/${repo}/raw/${ref}/${p}`;
}

/**
 * 构造仓库文件抓取器。
 *
 * @param {object} [opts]
 * @param {(url: string) => Promise<string>} [opts.fetchText]
 */
export function createRawFetcher(opts = {}) {
  const fetchText = opts.fetchText ?? defaultFetchText;
  return async function fetchRepoFile(host, owner, repo, ref, repoPath) {
    const url = rawUrl(host, owner, repo, ref, repoPath);
    try {
      return await fetchText(url);
    } catch (err) {
      // github.com 回退到 /raw/ 路径（部分镜像 / 代理只放行这种形式）
      if (host === 'github.com' && !url.includes('/raw/')) {
        const alt = `https://github.com/${owner}/${repo}/raw/${ref}/${repoPath.replace(/^\/+/, '')}`;
        return await fetchText(alt);
      }
      throw err;
    }
  };
}
