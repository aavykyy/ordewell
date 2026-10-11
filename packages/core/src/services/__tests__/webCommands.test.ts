import { describe, expect, it } from 'vitest';
import { wgetVersionCommands } from '../webCommands';

describe('wget version probes', () => {
  it('refuses cmd navigation that would expose commands when quoted again', () => {
    expect(wgetVersionCommands('cd a^"^&calc^&^"b && wget -O - https://x.com/', 'cmd')).toEqual([undefined]);
    for (const target of ['a^%b', 'a^&b', 'a^|b', 'a^<b', 'a^>b', 'a^^b', 'a^(b^)', 'a^!b']) {
      expect(wgetVersionCommands(`cd ${target} && wget -O - https://x.com/`, 'cmd')).toEqual([undefined]);
    }
    expect(wgetVersionCommands('cd "a b" && wget -O - https://x.com/', 'cmd')).toEqual([
      'cd "a b" && set "XDG_DATA_HOME=/dev/null" && set "XDG_CONFIG_HOME=/dev/null" && set "LOCALAPPDATA=NUL" && "wget" --no-config --version',
    ]);
    expect(wgetVersionCommands('cd \'a"&calc&"b\' && wget -O - https://x.com/', 'posix')).toEqual([
      'cd \'a"&calc&"b\' && XDG_DATA_HOME=/dev/null XDG_CONFIG_HOME=/dev/null LOCALAPPDATA=NUL \'wget\' --no-config --version',
    ]);
  });

  it('never builds a probe for a path-named executable', () => {
    for (const binary of ['./bin/wget', '/tmp/wget', '/usr/bin/wget']) {
      expect(wgetVersionCommands(`${binary} -O - https://x.com/`, 'posix')).toEqual([undefined]);
    }
    expect(wgetVersionCommands('C:\\bin\\wget.exe -O - https://x.com/', 'cmd')).toEqual([undefined]);
  });
});
