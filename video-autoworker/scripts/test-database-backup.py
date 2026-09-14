import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import tarfile
import time
import io
from unittest.mock import patch
import unittest

spec = importlib.util.spec_from_file_location('database_backup', Path(__file__).with_name('database-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
service_spec = importlib.util.spec_from_file_location('database_backup_service', Path(__file__).with_name('database-backup-service.py'))
service = importlib.util.module_from_spec(service_spec)
service_spec.loader.exec_module(service)

class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='vaw-backup-')
        self.root = Path(self.tmp.name).resolve(); self.root.chmod(0o700)
        self.source = self.root/'source.db'
        self.source.touch(mode=0o600)
        with sqlite3.connect(self.source) as db:
            db.execute('pragma journal_mode=WAL')
            db.execute('create table evidence(id integer primary key,value text)')
            db.execute("insert into evidence values(1,'must survive')")
        db.close()
        self.source.chmod(0o600)
        self.snapshots = self.root/'snapshots'; self.snapshots.mkdir(mode=0o700)
        self.item = {'name':'mission-control','database':str(self.source),'directory':str(self.snapshots)}
    def tearDown(self): self.tmp.cleanup()
    def test_retains_two_verified_snapshots_and_preserves_unknown_files(self):
        unknown=self.snapshots/'historical.db';unknown.write_bytes(b'unknown unique recovery');unknown.chmod(0o600)
        source_sha=backup.digest(self.source)
        for _ in range(3): backup.snapshot(self.item, force=True)
        self.assertEqual(len(backup.inventory(self.item)),2)
        self.assertEqual(unknown.read_bytes(),b'unknown unique recovery')
        self.assertEqual(backup.digest(self.source),source_sha)
    def test_wal_snapshot_restores_without_touching_live_database(self):
        live=sqlite3.connect(self.source)
        live.execute("insert into evidence values(2,'WAL committed')");live.commit()
        backup.snapshot(self.item,force=True)
        isolated=self.root/'isolated';isolated.mkdir(mode=0o700)
        result=backup.restore_drill(self.item,isolated/'restored.db')
        self.assertFalse(result['productionModified'])
        with backup.readonly_db(isolated/'restored.db', immutable=True) as restored:
            self.assertEqual(restored.execute('select count(*) from evidence').fetchone()[0],2)
        restored.close()
        self.assertEqual(live.execute('select count(*) from evidence').fetchone()[0],2)
        live.close()
    def test_tampered_backup_blocks_rotation(self):
        backup.snapshot(self.item,force=True)
        records=backup.inventory(self.item)
        target=self.snapshots/records[0][1]['file'];target.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError,'digest_mismatch'):backup.snapshot(self.item,force=True)
        self.assertTrue(target.exists())
    def test_catchup_and_idempotent_schedule(self):
        self.assertEqual(backup.due_day(dt.datetime(2026,9,14,3,29)), '2026-09-13')
        self.assertEqual(backup.due_day(dt.datetime(2026,9,14,3,30)), '2026-09-14')
        backup.snapshot(self.item,force=True)
        self.assertEqual(backup.snapshot(self.item)['state'],'current')
    def test_restore_requires_new_isolated_path(self):
        backup.snapshot(self.item,force=True)
        with self.assertRaises(ValueError):backup.restore_drill(self.item,self.source)
    def test_wrong_source_does_not_adopt_foreign_receipt(self):
        backup.snapshot(self.item,force=True)
        with self.assertRaisesRegex(ValueError,'scope_invalid'):
            backup.inventory({**self.item,'name':'n8n'})

    def test_status_does_not_create_missing_directory(self):
        missing = self.root/'does-not-exist'
        source = {**self.item, 'directory': str(missing)}
        config = {'schema': backup.SCHEMA, 'sources': [source]}
        backup.validate_config(config)
        self.assertEqual(backup.status(source)['state'], 'missing')
        self.assertFalse(missing.exists())

    def test_deployment_backup_only_skips_an_unchanged_committed_source(self):
        backup.snapshot(self.item, force=True)
        self.assertEqual(backup.snapshot(self.item, if_changed=True)['reason'], 'source_unchanged')
        with sqlite3.connect(self.source) as live:
            live.execute("insert into evidence values(2,'new committed state')")
        live.close()
        self.assertEqual(backup.snapshot(self.item, if_changed=True)['state'], 'verified')

    def test_legacy_external_sqlite_counts_toward_the_same_two_versions(self):
        legacy = self.root/'legacy'; legacy.mkdir(mode=0o700)
        entries = []
        for index in range(2):
            path = legacy/f'old-{index}.db'
            backup.consistent_copy(self.source, path)
            entries.append({'path':str(path),'format':'sqlite','sha256':backup.digest(path),
                            'completedAt':time.time()-200+index})
        plan = {'schema':backup.SCHEMA,'source':'mission-control','entries':entries}
        self.assertEqual(backup.import_legacy(self.item, plan)['retained'], 2)
        self.assertTrue(all(Path(entry['path']).exists() for entry in entries))
        self.assertEqual(backup.import_legacy(self.item, plan)['imported'][0]['state'], 'already_imported')
        backup.snapshot(self.item, force=True)
        self.assertFalse(Path(entries[0]['path']).exists())
        self.assertTrue(Path(entries[1]['path']).exists())
        self.assertEqual(len(backup.inventory(self.item)), 2)
        self.assertEqual(backup.import_legacy(self.item, plan)['imported'][0]['state'], 'already_retired')

    def test_legacy_archive_replays_wal_and_preserves_non_database_assets_on_retirement(self):
        legacy = self.root/'legacy-tar'; legacy.mkdir(mode=0o700)
        archive = legacy/'n8n-state.tar.gz'
        live = sqlite3.connect(self.source)
        live.execute('pragma journal_mode=WAL')
        live.execute("insert into evidence values(2,'committed in WAL')");live.commit()
        member = 'n8n/.n8n/database.sqlite'
        assets = b'private recovery configuration'
        with tarfile.open(archive, 'w:gz') as out:
            out.add(self.source, arcname=member)
            out.add(str(self.source)+'-wal', arcname=member+'-wal')
            out.add(str(self.source)+'-shm', arcname=member+'-shm')
            info=tarfile.TarInfo('n8n/.n8n/config');info.size=len(assets);info.mode=0o600
            out.addfile(info,io.BytesIO(assets))
            out.addfile(tarfile.TarInfo('n8n/database.sqlite'),io.BytesIO(b''))
        archive.chmod(0o600)
        entry = {'path':str(archive),'format':'sqlite-tar','sha256':backup.digest(archive),
                 'databaseMember':member,'completedAt':time.time()-200}
        backup.import_legacy(self.item, {'schema':backup.SCHEMA,'source':'mission-control','entries':[entry]})
        isolated=self.root/'isolated-tar';isolated.mkdir(mode=0o700)
        backup.restore_drill(self.item, isolated/'restored.db')
        with backup.readonly_db(isolated/'restored.db', immutable=True) as restored:
            self.assertEqual(restored.execute('select count(*) from evidence').fetchone()[0],2)
        restored.close()
        backup.snapshot(self.item, force=True)
        backup.snapshot(self.item, force=True)
        self.assertFalse(archive.exists())
        with tarfile.open(legacy/'n8n-runtime-assets.tar.gz') as kept:
            self.assertEqual(kept.getnames(),['n8n/.n8n/config'])
            self.assertEqual(kept.extractfile('n8n/.n8n/config').read(),assets)
        self.assertEqual(len(backup.inventory(self.item)),2)
        live.close()

    def test_legacy_hash_mismatch_blocks_import_without_deletion(self):
        folder=self.root/'legacy-bad';folder.mkdir(mode=0o700)
        legacy=folder/'legacy.db';backup.consistent_copy(self.source,legacy)
        plan={'schema':backup.SCHEMA,'source':'mission-control','entries':[{
            'path':str(legacy),'format':'sqlite','sha256':'0'*64,'completedAt':time.time()-10}]}
        with self.assertRaisesRegex(ValueError,'legacy_digest_mismatch'):
            backup.import_legacy(self.item,plan)
        self.assertTrue(legacy.exists())
        self.assertEqual(backup.inventory(self.item),[])

    def test_source_alias_and_cross_inventory_overlap_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'overlap'):
            backup.validate_config({'schema':backup.SCHEMA,'sources':[self.item,{**self.item,'name':'alias'}]})

    def test_launchagent_installation_is_private_idempotent_and_does_not_start_processes(self):
        config=self.root/'config.json'
        backup.save_json(config,{'schema':backup.SCHEMA,'sources':[self.item]})
        logs=self.root/'logs';agents=self.root/'LaunchAgents'
        with patch.object(service.subprocess,'run') as processes:
            installed=service.install(config,logs,agents)
            self.assertTrue(installed['changed'])
            self.assertFalse(installed['started'])
            self.assertFalse(service.install(config,logs,agents)['changed'])
            processes.assert_not_called()
        plist=service.read_plist(Path(installed['plist']))
        self.assertEqual(plist['StartCalendarInterval'],{'Hour':3,'Minute':30})
        self.assertTrue(plist['RunAtLoad'])
        self.assertEqual(plist['StartInterval'],3600)
        self.assertEqual(plist['ProgramArguments'][-3:],['run','--config',str(config)])
        self.assertEqual(Path(installed['plist']).stat().st_mode&0o777,0o600)

    def test_retirement_recovers_after_database_unlink_before_receipt_unlink(self):
        backup.snapshot(self.item,force=True)
        first_receipt,first=backup.inventory(self.item)[0]
        saved_receipt=first_receipt.read_bytes()
        backup.snapshot(self.item,force=True)
        backup.snapshot(self.item,force=True)
        first_receipt.write_bytes(saved_receipt);first_receipt.chmod(0o600)
        self.assertEqual(len(backup.inventory(self.item)),2)
        backup.rotate(self.item)
        self.assertFalse(first_receipt.exists())

if __name__ == '__main__': unittest.main()
