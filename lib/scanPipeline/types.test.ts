import { StageUnavailable, asImg } from './types';

describe('StageUnavailable', () => {
  it('is an Error that names the stage, with a fixed message', () => {
    const e = new StageUnavailable('locate');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(StageUnavailable);
    expect(e.name).toBe('StageUnavailable');
    expect(e.stage).toBe('locate');
    expect(e.message).toBe('The locate step is not available.');
  });
});

describe('asImg', () => {
  it('keeps the platform handle unchanged', () => {
    expect(asImg('file:///tmp/a.jpg')).toBe('file:///tmp/a.jpg');
  });
});
