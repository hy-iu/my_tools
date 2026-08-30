// Cross-platform project path normalization. The same checkout is seen as
// `F:\models` (Windows host), `/mnt/f/models` (WSL) and `\\wsl.localhost\…`
// (Windows reading into WSL). Canonical form groups them into one project:
//   C:\Users\x\p            -> c:/Users/x/p
//   /mnt/f/models           -> f:/models
//   \\wsl.localhost\U\h\w   -> /h/w        (WSL-native path, no Windows twin)
// Everything else keeps its POSIX form with forward slashes.

/** Normalize a cwd seen on the given platform id into a canonical project key. */
export function canonicalProjectPath(cwd: string | null | undefined, platform = 'local'): string {
  if (!cwd) return '?';
  let p = String(cwd).trim();
  if (!p) return '?';

  // Windows -> WSL UNC: \\wsl.localhost\<distro>\home\w\x or \\wsl$\<distro>\...
  const unc = p.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/i);
  if (unc) {
    p = '/' + unc[2].replace(/\\/g, '/');
    return posixNormalize(p);
  }

  // WSL/Windows drive mounts: /mnt/<drive>/... and /<drive>/...
  const mnt = p.match(/^\/mnt\/([A-Za-z])\/(.*)$/) ?? p.match(/^\/([A-Za-z])\/(.*)$/);
  if (mnt && /^[a-z]$/i.test(mnt[1]) && !p.startsWith('/home/') && !p.startsWith('/Users/') && !p.startsWith('/root/') && !p.startsWith('/tmp') && !p.startsWith('/opt') && !p.startsWith('/var')) {
    return `${mnt[1].toLowerCase()}:/${mnt[2].replace(/\\/g, '/')}`.replace(/\/+$/, '') || `${mnt[1].toLowerCase()}:/`;
  }

  if (/^[A-Za-z]:[\\/]/.test(p)) {
    const norm = p.replace(/\\/g, '/');
    return norm.charAt(0).toLowerCase() + norm.slice(1).replace(/\/+$/, '');
  }
  return posixNormalize(p);
}

function posixNormalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

/** Short display name for a canonical project path. */
export function projectDisplayName(canonical: string): string {
  if (!canonical || canonical === '?') return '?';
  const segs = canonical.split('/').filter(Boolean);
  return segs.pop() ?? canonical;
}
