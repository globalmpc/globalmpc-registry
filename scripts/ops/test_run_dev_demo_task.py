import importlib.util
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("demo_task", Path(__file__).with_name("run-dev-demo-task.py"))
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


class TaskTests(unittest.TestCase):
    outputs = {"Stacks": [{"Outputs": [
        {"OutputKey": "RunTaskCommand", "OutputValue": 'aws ecs run-task --cluster cluster --task-definition migration --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[private],securityGroups=[sg-private]}"'},
        {"OutputKey": "MigrateLogGroup", "OutputValue": "/ecs/migrations"},
    ]}]}
    launched = {"tasks": [{"taskArn": "arn:aws:ecs:region:account:task/cluster/seed", "clusterArn": "arn:aws:ecs:region:account:cluster/cluster"}]}

    def test_non_dev_never_calls_aws(self):
        with patch.dict(os.environ, {"DEPLOY_ENVIRONMENT": "production", "CHAIN_ID": "5611"}), patch.object(demo, "aws") as api:
            with self.assertRaises(RuntimeError):
                demo.run("stack")
            api.assert_not_called()

    def test_launch_failure_never_waits(self):
        with patch.dict(os.environ, {"DEPLOY_ENVIRONMENT": "develop", "CHAIN_ID": "5611"}), patch.object(demo, "aws", side_effect=[self.outputs, {"tasks": [], "failures": [{"reason": "denied"}]}]), patch.object(demo.subprocess, "run") as wait:
            with self.assertRaisesRegex(RuntimeError, "did not launch"):
                demo.run("stack")
            wait.assert_not_called()

    def test_missing_exit_is_not_success(self):
        with patch.dict(os.environ, {"DEPLOY_ENVIRONMENT": "develop", "CHAIN_ID": "5611"}), patch.object(demo, "aws", side_effect=[self.outputs, self.launched, {"tasks": [{"containers": [{"name": "Migrate"}]}]}]), patch.object(demo.subprocess, "run"):
            with self.assertRaisesRegex(RuntimeError, "task failed"):
                demo.run("stack")

    def test_waiter_failure_stops_owned_task(self):
        with patch.dict(os.environ, {"DEPLOY_ENVIRONMENT": "develop", "CHAIN_ID": "5611"}), patch.object(demo, "aws", side_effect=[self.outputs, self.launched, {}]) as api, patch.object(demo.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "wait")):
            with self.assertRaisesRegex(RuntimeError, "stop requested"):
                demo.run("stack")
            self.assertEqual(api.call_args.args[:2], ("ecs", "stop-task"))

    def test_seed_override_runs_through_task_and_image_entrypoints(self):
        import json
        root = Path(__file__).resolve().parents[2]
        with patch.dict(os.environ, {"DEPLOY_ENVIRONMENT": "develop", "CHAIN_ID": "5611"}), patch.object(demo, "aws", side_effect=[self.outputs, self.launched, {"tasks": [{"containers": [{"exitCode": 0}]}]}]) as api, patch.object(demo.subprocess, "run"):
            demo.run("stack")
            arguments = api.call_args_list[1].args
            override = json.loads(arguments[arguments.index("--overrides") + 1])
        command = override["containerOverrides"][0]["command"]
        command = [str(root / arg.removeprefix("/repo/")) if arg.startswith("/repo/") else arg for arg in command]
        # The production guard proves the real script ran, before any DB or AWS I/O.
        # Check both the ECS task's shell and the image wrapper's direct exec path.
        for entrypoint in [["/bin/sh"], ["sh", str(root / "etc/otel/otel-wrapper.sh")]]:
            with self.subTest(entrypoint=entrypoint):
                result = subprocess.run([*entrypoint, *command], capture_output=True, text=True,
                                        env={"PATH": os.defpath, "DEPLOY_ENVIRONMENT": "production", "CHAIN_ID": "5611"})
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("dev demo requires develop", result.stderr)

    def test_success_uses_private_network_and_only_seed_override(self):
        with patch.dict(os.environ, {"DEPLOY_ENVIRONMENT": "develop", "CHAIN_ID": "5611"}), patch.object(demo, "aws", side_effect=[self.outputs, self.launched, {"tasks": [{"containers": [{"exitCode": 0}]}]}]) as api, patch.object(demo.subprocess, "run"):
            demo.run("stack")
            arguments = api.call_args_list[1].args
            self.assertIn("awsvpcConfiguration={subnets=[private],securityGroups=[sg-private]}", arguments)
            self.assertIn("seed-demo-task.sh", arguments[arguments.index("--overrides") + 1])


if __name__ == "__main__":
    unittest.main()
