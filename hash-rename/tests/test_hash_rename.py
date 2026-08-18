import os
import shutil
import unittest
import uuid
from pathlib import Path

import hash_rename


class HashRenameTests(unittest.TestCase):
    def setUp(self):
        base = Path(os.environ.get("HASH_RENAME_TEST_ROOT", Path(__file__).parent / ".test-tmp"))
        self.root = base / uuid.uuid4().hex
        self.root.mkdir(parents=True)
        self.source_dir = self.root / "pictures"
        self.target_dir = self.root / "favorites"
        self.source_dir.mkdir()
        self.target_dir.mkdir()
        self.source = self.source_dir / "meaningful-title.jpg"
        self.target = self.target_dir / "download-001.jpg"
        self.source.write_bytes(b"same bytes\n")
        self.target.write_bytes(b"same bytes\n")
        self.previous_history = hash_rename.HISTORY_PATH
        hash_rename.HISTORY_PATH = self.root / "history.jsonl"

    def tearDown(self):
        hash_rename.HISTORY_PATH = self.previous_history
        shutil.rmtree(self.root)

    def make_session(self, algorithm="sha256"):
        digest = hash_rename.hash_file(self.source, algorithm)
        donor = hash_rename.ScannedFile("f1", str(self.source_dir), str(self.source), self.source.name, self.source.name, self.source.stat().st_size, self.source.stat().st_mtime, digest)
        target = hash_rename.ScannedFile("f2", str(self.target_dir), str(self.target), self.target.name, self.target.name, self.target.stat().st_size, self.target.stat().st_mtime, digest)
        group = hash_rename.Group("g1", digest, self.source.stat().st_size, [donor, target])
        return hash_rename.Session("s1", [str(self.source_dir), str(self.target_dir)], [group], {"f1": donor, "f2": target}, "now", algorithm)

    def test_plan_uses_selected_donor_name(self):
        plan = hash_rename.build_plan(self.make_session(), [{"group_id": "g1", "donor_id": "f1", "target_ids": ["f2"]}])
        self.assertEqual(len(plan), 1)
        self.assertEqual(Path(plan[0].destination).name, "meaningful-title.jpg")
        self.assertIsNone(plan[0].conflict)

    def test_execute_and_undo_preserve_content(self):
        plan = hash_rename.build_plan(self.make_session(), [{"group_id": "g1", "donor_id": "f1", "target_ids": ["f2"]}])
        transaction = hash_rename.verify_and_execute(plan)
        renamed = self.target_dir / "meaningful-title.jpg"
        self.assertTrue(renamed.exists())
        self.assertFalse(self.target.exists())
        self.assertEqual(renamed.read_bytes(), b"same bytes\n")
        hash_rename.undo_transaction(transaction["id"])
        self.assertTrue(self.target.exists())
        self.assertFalse(renamed.exists())

    def test_existing_unselected_destination_is_conflict(self):
        (self.target_dir / "meaningful-title.jpg").write_bytes(b"unrelated")
        plan = hash_rename.build_plan(self.make_session(), [{"group_id": "g1", "donor_id": "f1", "target_ids": ["f2"]}])
        self.assertEqual(plan[0].conflict, "目标文件名已存在")

    def test_custom_name_is_used_and_invalid_path_is_rejected(self):
        plan = hash_rename.build_plan(self.make_session(), [{"group_id": "g1", "donor_id": "f1", "use_custom_name": True, "custom_name": "我确认的名字.jpg", "target_ids": ["f2"]}])
        self.assertEqual(Path(plan[0].destination).name, "我确认的名字.jpg")
        with self.assertRaisesRegex(ValueError, "不能包含文件夹路径"):
            hash_rename.build_plan(self.make_session(), [{"group_id": "g1", "donor_id": "f1", "use_custom_name": True, "custom_name": "folder\\name.jpg", "target_ids": ["f2"]}])
        with self.assertRaisesRegex(ValueError, "不能为空"):
            hash_rename.build_plan(self.make_session(), [{"group_id": "g1", "use_custom_name": True, "custom_name": "", "target_ids": ["f2"]}])

    def test_all_targets_with_same_destination_are_marked_conflicts(self):
        second = self.target_dir / "download-002.jpg"
        second.write_bytes(b"same bytes\n")
        session = self.make_session()
        digest = session.groups[0].digest
        item = hash_rename.ScannedFile("f3", str(self.target_dir), str(second), second.name, second.name, second.stat().st_size, second.stat().st_mtime, digest)
        session.groups[0].files.append(item)
        session.files[item.file_id] = item
        plan = hash_rename.build_plan(session, [{"group_id": "g1", "donor_id": "f1", "target_ids": ["f2", "f3"]}])
        self.assertEqual([operation.conflict for operation in plan], ["同一目录的多个目标会得到同一个文件名"] * 2)

    def test_target_already_using_requested_name_needs_no_operation(self):
        self.target = self.target.rename(self.target_dir / self.source.name)
        session = self.make_session()
        plan = hash_rename.build_plan(session, [{"group_id": "g1", "donor_id": "f1", "target_ids": ["f2"]}])
        self.assertEqual(plan, [])

    def test_blake2b_transaction_can_be_undone_once(self):
        plan = hash_rename.build_plan(self.make_session("blake2b"), [{"group_id": "g1", "donor_id": "f1", "target_ids": ["f2"]}])
        transaction = hash_rename.verify_and_execute(plan, "blake2b")
        hash_rename.undo_transaction(transaction["id"])
        self.assertTrue(self.target.exists())
        with self.assertRaisesRegex(ValueError, "找不到可撤销"):
            hash_rename.undo_transaction(transaction["id"])


if __name__ == "__main__":
    unittest.main()
