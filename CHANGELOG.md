# Changelog

## [0.9.0] - 2026-04-08

### Changed
- Extended broadcastNodeMoved with oldName/newName parameters to support atomic move+rename operations

### Fixed
- Removed stale broadcastFileSaved JSDoc comment left above broadcastNodeSaved

### Breaking Changes
- Replaced broadcastFile* methods with broadcastNode* methods



## [0.8.0] - 2026-02-26

### Added
- Broadcast methods for file rename, move, and delete events



## [0.7.1] - 2026-01-31

### Added
- Browser save tracking to prevent duplicate notifications



## [0.7.0] - 2026-01-22

### Changed
- Add sync engine subscriptions and notification support



## [0.6.0] - 2026-01-10

### Added
- Full document sync API with html and sender parameters

### Changed
- Removed release.sh script


