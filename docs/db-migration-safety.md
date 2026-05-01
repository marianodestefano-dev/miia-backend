# MIIA DB Migration Safety Protocol

## Principles
1. All migrations are additive-first (add fields, never rename/delete without deprecation window).
2. Dry-run before live: `node scripts/fortaleza_migration_dry_run.js` pattern for all migrations.
3. Rollback plan required before any migration executes.
4. Test in staging (MIIA CENTER) before production (all owners).

## Migration Checklist
- [ ] Backup Firestore export to GCS before migration
- [ ] Dry-run with --dry flag, review report
- [ ] Confirm no breaking changes to existing reads
- [ ] Deploy new code reading both old and new field names
- [ ] Run migration script
- [ ] Verify sample of 10 docs manually
- [ ] Monitor error rate for 30 min post-migration
- [ ] Remove old field name from code after 1 week

## Known Safe Operations
- Adding new optional fields to documents
- Adding new collections
- Adding indexes

## Operations Requiring Full Protocol
- Renaming fields (requires dual-read window)
- Changing field types
- Restructuring subcollections
- Deleting fields or collections
