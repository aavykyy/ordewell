import { beforeEach, describe, expect, it, vi } from 'vitest';

const stopDaemon = vi.fn(async () => true);
const resolvePort = vi.fn(() => 4242);

vi.mock('../../daemon', () => ({
  stopDaemon,
  resolvePort,
  ensureDaemon: vi.fn(async () => 4242),
  isConnectionRefused: () => false,
  describeConnectionRefused: () => '',
  DEFAULT_PORT: 3742,
}));

describe('the stop-server alias', () => {
  beforeEach(() => {
    stopDaemon.mockClear();
    resolvePort.mockClear();
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => { throw new Error(`exit:${code ?? 0}`); });
  });

  it('stops the daemon, not the last session', async () => {
    const { COMMANDS } = await import('../registry');

    await COMMANDS['stop-server']([]);

    expect(stopDaemon).toHaveBeenCalledWith(4242);
  });
});
