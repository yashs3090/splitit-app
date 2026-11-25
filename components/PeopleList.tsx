// "People you've split with" rows: a search field (only with more than 5 people), one row per
// person (initials, name, caption), an optional action per row, and the empty / no-match lines.
// Spec: docs/specs/2026-11-24-people-and-invites.md (D6; Task 6). Used by Profile and Add people.
//
// A row is display only. Its text is one screen-reader element (personA11yLabel); an action
// (e.g. "Add Sam Lee") sits beside it as its own button, so grouping never hides the button.
import { useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatars';
import { ListRow } from '@/components/ui/ListRow';
import { TextField } from '@/components/ui/TextField';
import { initials } from '@/lib/billView';
import { filterPeople, personA11yLabel, personCaption, personName, type FormatDate, type Person } from '@/lib/people';
import { noMatchesText, PEOPLE_COPY, showSearch } from '@/lib/peopleView';
import { space, type, useTheme } from '@/lib/theme';

type Props = {
  /** The people to list, in the order given (L2). */
  people: readonly Person[];
  /** Everyone the same-name check compares against (PI-10). Defaults to `people`. */
  all?: readonly Person[];
  formatDate: FormatDate;
  /** Shown when `people` is empty. */
  emptyText: string;
  renderAction?: (person: Person) => ReactNode;
};

export function PeopleList({ people, all = people, formatDate, emptyText, renderAction }: Props) {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const searchable = showSearch(people.length);
  // When the list shrinks to 5 or fewer the field goes away, and so does its filter.
  const shown = searchable ? filterPeople(people, query) : people;

  if (people.length === 0) {
    return <Text style={[type.body, { color: colors.textMuted }]}>{emptyText}</Text>;
  }

  return (
    <View style={styles.wrap}>
      {searchable ? (
        <TextField
          label={PEOPLE_COPY.searchLabel}
          placeholder={PEOPLE_COPY.searchLabel}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          textContentType="none"
          returnKeyType="search"
          maxLength={100}
        />
      ) : null}
      {shown.length === 0 ? (
        <Text accessibilityLiveRegion="polite" style={[type.body, { color: colors.textMuted }]}>
          {noMatchesText(query)}
        </Text>
      ) : (
        <View>
          {shown.map((person, i) => (
            <ListRow
              key={person.userId}
              edgeToEdge={false}
              divider={i > 0}
              accessibilityLabel={personA11yLabel(person, all, formatDate)}
              leading={
                <Avatar
                  person={{ userId: person.userId, name: personName(person), initials: initials(person.displayName), isMe: false }}
                />
              }
              title={personName(person)}
              caption={personCaption(person, all, formatDate)}
              trailing={renderAction ? renderAction(person) : undefined}
            />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
});
