package sift

// ClearNotifications removes the listed notifications in one transaction and
// history group, so the board refreshes once. The caller names exactly what
// the person saw: a notification that arrives while they click "Clear all" is
// kept. IDs that are already gone are skipped, which makes clearing from two
// windows at once harmless. It reports how many were removed.
func (s *Store) ClearNotifications(ids []string, actor string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	group, cleared := newID("clear_"), 0
	for _, id := range ids {
		if rawTx(tx, "notification", id) == nil {
			continue
		}
		if err = putTx(tx, "notification", id, nil, actor, "Cleared notification", group); err != nil {
			return 0, err
		}
		cleared++
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	if cleared > 0 {
		s.signal()
	}
	return cleared, nil
}
