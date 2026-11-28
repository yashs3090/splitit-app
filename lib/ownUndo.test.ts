// The viewer's own "No, undo" (review R8): the Settle page must not call it someone else's undo.
import { forgetOwnUndo, noteOwnUndo, OWN_UNDO_MAX_MS, ownUndoLanded, resetOwnUndosForTests, subscribeOwnUndo, takeOwnUndo } from './ownUndo';

const BILL = '11111111-1111-4111-8111-111111111111';
const OTHER_BILL = '11111111-1111-4111-8111-222222222222';
const SAM = '00000000-0000-4000-8000-00000000000b';
const DEE = '00000000-0000-4000-8000-00000000000d';
const T = 1_800_000_000_000;

beforeEach(() => resetOwnUndosForTests());

describe('own undo registry', () => {
  it('a noted undo is taken once, for that bill and user only', () => {
    noteOwnUndo(BILL, SAM, T);
    expect(takeOwnUndo(OTHER_BILL, SAM, T)).toBe(false);
    expect(takeOwnUndo(BILL, DEE, T)).toBe(false);
    expect(takeOwnUndo(BILL, SAM, T + 1)).toBe(true);
    expect(takeOwnUndo(BILL, SAM, T + 2)).toBe(false);
  });

  it('nothing noted → false (someone else undid it)', () => {
    expect(takeOwnUndo(BILL, SAM, T)).toBe(false);
  });

  it('a failed unmark forgets it', () => {
    noteOwnUndo(BILL, SAM, T);
    forgetOwnUndo(BILL, SAM);
    expect(takeOwnUndo(BILL, SAM, T)).toBe(false);
  });

  it('expires after OWN_UNDO_MAX_MS, so it never hides a later undo by someone else', () => {
    noteOwnUndo(BILL, SAM, T);
    expect(takeOwnUndo(BILL, SAM, T + OWN_UNDO_MAX_MS + 1)).toBe(false);
    noteOwnUndo(BILL, SAM, T);
    expect(takeOwnUndo(BILL, SAM, T + OWN_UNDO_MAX_MS)).toBe(true);
  });

  it('ownUndoLanded tells subscribers which bill and user, until they unsubscribe', () => {
    const seen: string[] = [];
    const off = subscribeOwnUndo((billId, userId) => seen.push(`${billId}|${userId}`));
    ownUndoLanded(BILL, SAM);
    off();
    ownUndoLanded(BILL, DEE);
    expect(seen).toEqual([`${BILL}|${SAM}`]);
  });

  it('a throwing subscriber does not stop the others', () => {
    const seen: string[] = [];
    subscribeOwnUndo(() => {
      throw new Error('boom');
    });
    subscribeOwnUndo((b) => seen.push(b));
    expect(() => ownUndoLanded(BILL, SAM)).not.toThrow();
    expect(seen).toEqual([BILL]);
  });
});
