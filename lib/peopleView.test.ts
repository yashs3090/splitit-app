// Screen copy and "On this bill" rows for the People card and the Add people screen.
// Spec: docs/specs/2026-11-24-people-and-invites.md (D6; Tasks 6 and 7).
import { makeNameOf } from './billView';
import type { BillData, BillMember } from './bills';
import {
  addedText,
  noMatchesText,
  onlyHostText,
  onThisBillRows,
  PEOPLE_COPY,
  removedText,
  showSearch,
} from './peopleView';

const HOST = '00000000-0000-4000-8000-00000000000a';
const SAM = '00000000-0000-4000-8000-00000000000b';
const CY = '00000000-0000-4000-8000-00000000000c';
const DEE = '00000000-0000-4000-8000-00000000000d';
const ROW = '22222222-0000-4000-8000-000000000001';

const member = (userId: string, displayName: string | null, mark: BillMember['mark'] = null): BillMember => ({
  userId,
  displayName,
  venmoUsername: null,
  mark,
});

function bill(participants: BillMember[], claims: { line_item_id: string; user_id: string; parts: number }[] = [], payerId = HOST): BillData {
  // Test double: only the fields these helpers read are meaningful.
  return {
    bill: { id: 'b', host_id: HOST, payer_id: payerId } as unknown as BillData['bill'],
    rows: [],
    participants,
    claims,
  };
}

describe('showSearch (PI-9)', () => {
  it('shows the search field only with more than 5 people', () => {
    expect(showSearch(0)).toBe(false);
    expect(showSearch(5)).toBe(false);
    expect(showSearch(6)).toBe(true);
  });
});

describe('sentences', () => {
  it('noMatchesText quotes the trimmed query', () => {
    expect(noMatchesText('zzz')).toBe('No one matches "zzz".');
    expect(noMatchesText('  sam  ')).toBe('No one matches "sam".');
  });

  it('noMatchesText cuts the query to the 50 characters search uses', () => {
    expect(noMatchesText('a'.repeat(60))).toBe(`No one matches "${'a'.repeat(50)}".`);
  });

  it('onlyHostText names the host, or says "the host" when they have no name', () => {
    expect(onlyHostText('Hana Lee')).toBe('Only Hana Lee can add people.');
    expect(onlyHostText('  Hana  ')).toBe('Only Hana can add people.');
    expect(onlyHostText(null)).toBe('Only the host can add people.');
    expect(onlyHostText('   ')).toBe('Only the host can add people.');
  });

  it('added and removed announcements', () => {
    expect(addedText('Sam Lee')).toBe('Sam Lee added');
    expect(removedText('Sam Lee')).toBe('Sam Lee removed');
  });

  it('copy fixed by the spec', () => {
    expect(PEOPLE_COPY.emptyProfile).toBe('People you split bills with will show up here.');
    expect(PEOPLE_COPY.emptyAdd).toBe(
      'People you split bills with will show up here. To invite someone new, go back and share the link.',
    );
    expect(PEOPLE_COPY.everyoneOn).toBe("Everyone you've split with is on this bill.");
    expect(PEOPLE_COPY.leaveConfirm).toBe("Leave this bill? You'll stop seeing it. You can rejoin with the link.");
  });
});

describe('onThisBillRows', () => {
  it('puts the viewer first as "You", then the others in join order', () => {
    const data = bill([member(SAM, 'Sam Lee'), member(HOST, 'Hana'), member(CY, 'Cy')]);
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(rows.map((r) => r.name)).toEqual(['You', 'Sam Lee', 'Cy']);
  });

  it('marks people with no claims as "No items yet", the viewer included, and says it in the label', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam Lee'), member(CY, 'Cy')], [{ line_item_id: ROW, user_id: CY, parts: 1 }]);
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(rows.map((r) => [r.name, r.noItems, r.a11yLabel])).toEqual([
      ['You', true, 'You, no items yet'],
      ['Sam Lee', true, 'Sam Lee, no items yet'],
      ['Cy', false, 'Cy'],
    ]);
  });

  it('removable follows canRemove: M3 yes; the payer (M2), a claimer (M5), a mark (M7) and the host (M1) no', () => {
    const data = bill(
      [
        member(HOST, 'Hana'),
        member(SAM, 'Sam'),
        member(CY, 'Cy'),
        member(DEE, 'Dee', { cents: 100, at: '2026-11-20T19:00:00Z' }),
        member('00000000-0000-4000-8000-00000000000e', 'Eve'),
      ],
      [{ line_item_id: ROW, user_id: CY, parts: 1 }],
      '00000000-0000-4000-8000-00000000000e',
    );
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(Object.fromEntries(rows.map((r) => [r.name, r.removable]))).toEqual({
      You: false,
      Sam: true,
      Cy: false,
      Dee: false,
      Eve: false,
    });
  });

  it('a guest viewer can remove no one', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam'), member(CY, 'Cy')]);
    const rows = onThisBillRows(data, SAM, makeNameOf(data.participants, SAM));
    expect(rows.map((r) => r.removable)).toEqual([false, false, false]);
    expect(rows[0]?.name).toBe('You');
  });

  it('a person with no name reads "A friend"', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, null)]);
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(rows[1]?.name).toBe('A friend');
  });
});
