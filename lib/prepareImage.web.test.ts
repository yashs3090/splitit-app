// Web image preparation, imported by path (criterion 55, A3 / Task 9).
const mockManipulate = jest.fn();
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: (src: unknown) => mockManipulate(src) },
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));
const mockFileSystemFactory = jest.fn(() => ({}));
jest.mock('expo-file-system', () => mockFileSystemFactory());

import { deleteTempImages, prepareAtSize, prepareCropAtScale, prepareForRecognition } from './prepareImage.web';

type FakeRef = { uri: string; width: number; height: number; saveAsync: jest.Mock; release: jest.Mock };

function fakeRef(width: number, height: number, error?: Error): FakeRef {
  return {
    uri: `blob:render-${width}x${height}`,
    width,
    height,
    saveAsync: jest.fn(async () => {
      if (error) throw error;
      return { uri: `blob:saved-${width}x${height}`, width, height };
    }),
    release: jest.fn(),
  };
}

type FakeContext = { resize: jest.Mock; crop: jest.Mock; renderAsync: jest.Mock };

function fakeContext(rendered: FakeRef): FakeContext {
  const ctx: FakeContext = { resize: jest.fn(() => ctx), crop: jest.fn(() => ctx), renderAsync: jest.fn(async () => rendered) };
  return ctx;
}

// jsdom-less Jest: a minimal Image that "decodes" to a preset size, or fails.
let nextImage: { width: number; height: number } | 'error' = { width: 4032, height: 3024 };
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_v: string) {
    setTimeout(() => {
      if (nextImage === 'error') return this.onerror?.();
      this.naturalWidth = nextImage.width;
      this.naturalHeight = nextImage.height;
      this.onload?.();
    }, 0);
  }
}

const g = globalThis as Record<string, unknown>;
let revoke: jest.SpyInstance;
beforeAll(() => {
  g.Image = FakeImage;
});
afterAll(() => {
  delete g.Image;
});
beforeEach(() => {
  mockManipulate.mockReset();
  nextImage = { width: 4032, height: 3024 };
  revoke = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => revoke.mockRestore());

describe('prepareForRecognition (web)', () => {
  it('measures, resizes to 2048 on the long edge in one render, saves JPEG 0.9 and frees the render', async () => {
    const rendered = fakeRef(2048, 1536);
    const ctx = fakeContext(rendered);
    mockManipulate.mockReturnValueOnce(ctx);
    await expect(prepareForRecognition('blob:picked')).resolves.toEqual({ uri: 'blob:saved-2048x1536', width: 2048, height: 1536 });
    expect(mockManipulate).toHaveBeenCalledTimes(1);
    expect(mockManipulate).toHaveBeenCalledWith('blob:picked');
    expect(ctx.resize).toHaveBeenCalledWith({ width: 2048, height: 1536 });
    expect(rendered.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.9 });
    expect(revoke).toHaveBeenCalledWith('blob:render-2048x1536');
    expect(revoke).not.toHaveBeenCalledWith('blob:saved-2048x1536');
    expect(rendered.release).toHaveBeenCalled();
  });

  it('leaves a mid-size photo (long edge 1000–2048) at its size: no resize', async () => {
    nextImage = { width: 1000, height: 800 };
    const ctx = fakeContext(fakeRef(1000, 800));
    mockManipulate.mockReturnValueOnce(ctx);
    await expect(prepareForRecognition('blob:p')).resolves.toMatchObject({ width: 1000, height: 800 });
    expect(ctx.resize).not.toHaveBeenCalled();
  });

  it('upscales a low-resolution photo (263×450) to 935×1600 in one render and frees the render', async () => {
    nextImage = { width: 263, height: 450 };
    const rendered = fakeRef(935, 1600);
    const ctx = fakeContext(rendered);
    mockManipulate.mockReturnValueOnce(ctx);
    await expect(prepareForRecognition('blob:small')).resolves.toEqual({ uri: 'blob:saved-935x1600', width: 935, height: 1600 });
    expect(mockManipulate).toHaveBeenCalledTimes(1);
    expect(ctx.resize).toHaveBeenCalledWith({ width: 935, height: 1600 });
    expect(rendered.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.9 });
    expect(revoke).toHaveBeenCalledWith('blob:render-935x1600');
    expect(rendered.release).toHaveBeenCalled();
  });

  it('rejects with image_load_failed when the image cannot be decoded or saved', async () => {
    nextImage = 'error';
    await expect(prepareForRecognition('blob:bad')).rejects.toMatchObject({ name: 'RecognitionError', code: 'image_load_failed' });
    nextImage = { width: 100, height: 100 };
    const broken = fakeRef(100, 100, new Error('Unable to save image: blob:secret'));
    mockManipulate.mockReturnValueOnce(fakeContext(broken));
    const err = await prepareForRecognition('blob:p').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'image_load_failed' });
    expect((err as Error).message).not.toContain('secret');
    expect(broken.release).toHaveBeenCalled();
  });
});

describe('prepareAtSize (web, the text-height second pass)', () => {
  it('resizes to exactly the given size in one render (up or down, ignoring the size rule), saves JPEG 0.9 and frees the render', async () => {
    nextImage = { width: 700, height: 1200 };
    const rendered = fakeRef(1050, 1800);
    const ctx = fakeContext(rendered);
    mockManipulate.mockReturnValueOnce(ctx);
    await expect(prepareAtSize('blob:crop', { width: 1050, height: 1800 })).resolves.toEqual({
      uri: 'blob:saved-1050x1800',
      width: 1050,
      height: 1800,
    });
    expect(mockManipulate).toHaveBeenCalledWith('blob:crop');
    expect(ctx.resize).toHaveBeenCalledWith({ width: 1050, height: 1800 });
    expect(rendered.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.9 });
    expect(revoke).toHaveBeenCalledWith('blob:render-1050x1800');
    expect(rendered.release).toHaveBeenCalled();

    // A mid-size photo that the size rule would leave alone is still shrunk when asked.
    nextImage = { width: 1200, height: 1600 };
    const down = fakeContext(fakeRef(600, 800));
    mockManipulate.mockReturnValueOnce(down);
    await prepareAtSize('blob:p', { width: 600, height: 800 });
    expect(down.resize).toHaveBeenCalledWith({ width: 600, height: 800 });
  });

  it('no resize when the image already has that size', async () => {
    nextImage = { width: 800, height: 600 };
    const ctx = fakeContext(fakeRef(800, 600));
    mockManipulate.mockReturnValueOnce(ctx);
    await prepareAtSize('blob:p', { width: 800, height: 600 });
    expect(ctx.resize).not.toHaveBeenCalled();
  });

  it('rejects a non-integer or non-positive size, and a failed decode, with image_load_failed', async () => {
    for (const size of [{ width: 0, height: 10 }, { width: 10.5, height: 10 }, { width: 10, height: Number.NaN }]) {
      await expect(prepareAtSize('blob:p', size)).rejects.toMatchObject({ name: 'RecognitionError', code: 'image_load_failed' });
    }
    expect(mockManipulate).not.toHaveBeenCalled();
    nextImage = 'error';
    await expect(prepareAtSize('blob:bad', { width: 10, height: 10 })).rejects.toMatchObject({ code: 'image_load_failed' });
  });
});

describe('prepareCropAtScale (web, zoom on doubt)', () => {
  it('crops the clamped rect, then resizes it by the scale in the same render, saves JPEG 0.9 and frees the render', async () => {
    nextImage = { width: 1000, height: 2000 };
    const rendered = fakeRef(640, 80);
    const ctx = fakeContext(rendered);
    mockManipulate.mockReturnValueOnce(ctx);
    await expect(prepareCropAtScale('blob:pass', { x: -10, y: 50, width: 320, height: 40 }, 2)).resolves.toEqual({
      uri: 'blob:saved-640x80',
      width: 640,
      height: 80,
    });
    expect(mockManipulate).toHaveBeenCalledWith('blob:pass');
    // x clamped to 0, so 310 px wide; × 2.
    expect(ctx.crop).toHaveBeenCalledWith({ originX: 0, originY: 50, width: 310, height: 40 });
    expect(ctx.resize).toHaveBeenCalledWith({ width: 620, height: 80 });
    expect(ctx.crop.mock.invocationCallOrder[0]).toBeLessThan(ctx.resize.mock.invocationCallOrder[0] as number);
    expect(rendered.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.9 });
    expect(revoke).toHaveBeenCalledWith('blob:render-640x80');
    expect(rendered.release).toHaveBeenCalled();
  });

  it('scale 1 → crop only, no resize', async () => {
    nextImage = { width: 1000, height: 2000 };
    const ctx = fakeContext(fakeRef(100, 30));
    mockManipulate.mockReturnValueOnce(ctx);
    await prepareCropAtScale('blob:pass', { x: 10, y: 10, width: 100, height: 30 }, 1);
    expect(ctx.crop).toHaveBeenCalledWith({ originX: 10, originY: 10, width: 100, height: 30 });
    expect(ctx.resize).not.toHaveBeenCalled();
  });

  it('a rect outside the image, a bad scale or a failed decode → image_load_failed, nothing rendered', async () => {
    nextImage = { width: 100, height: 100 };
    await expect(prepareCropAtScale('blob:pass', { x: 200, y: 0, width: 10, height: 10 }, 2)).rejects.toMatchObject({
      name: 'RecognitionError',
      code: 'image_load_failed',
    });
    await expect(prepareCropAtScale('blob:pass', { x: 0, y: 0, width: 10, height: 10 }, 0)).rejects.toMatchObject({ code: 'image_load_failed' });
    nextImage = 'error';
    await expect(prepareCropAtScale('blob:bad', { x: 0, y: 0, width: 10, height: 10 }, 2)).rejects.toMatchObject({ code: 'image_load_failed' });
    expect(mockManipulate).not.toHaveBeenCalled();
  });
});

describe('deleteTempImages (web)', () => {
  it('revokes only blob: URLs and never throws (55)', async () => {
    await expect(
      deleteTempImages(['blob:x', 'data:image/png;base64,AAAA', 'https://x', undefined, null, '', 'blob:x']),
    ).resolves.toBeUndefined();
    expect(revoke.mock.calls).toEqual([['blob:x']]);
  });

  it('swallows revoke errors', async () => {
    revoke.mockImplementation(() => {
      throw new Error('nope');
    });
    await expect(deleteTempImages(['blob:a', 'blob:b'])).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it('never loads expo-file-system', () => {
    expect(mockFileSystemFactory).not.toHaveBeenCalled();
  });
});
