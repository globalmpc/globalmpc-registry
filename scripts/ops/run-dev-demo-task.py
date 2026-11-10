#!/usr/bin/env python3
"""Run the dev-only additive seed inside the existing migration task's VPC."""
import argparse
import json
import os
import shlex
import subprocess


def aws(*args):
    return json.loads(subprocess.check_output(["aws", *args, "--output", "json"], text=True))


def run(stack):
    if os.environ.get("DEPLOY_ENVIRONMENT") != "develop" or os.environ.get("CHAIN_ID") != "5611":
        raise RuntimeError("Demo seed requires develop and chain 5611")
    response = aws("cloudformation", "describe-stacks", "--stack-name", stack)
    outputs = {item["OutputKey"]: item["OutputValue"] for item in response["Stacks"][0]["Outputs"]}
    command = shlex.split(outputs["RunTaskCommand"])
    if command[:3] != ["aws", "ecs", "run-task"]:
        raise RuntimeError("Unexpected migration task command")
    # Parse the trusted stack output as arguments, never as shell program text.
    overrides = {"containerOverrides": [{"name": "Migrate", "command": ["/repo/docker/seed-demo-task.sh"]}]}
    launched = aws(*command[1:], "--overrides", json.dumps(overrides), "--started-by", "registry-dev-demo")
    if launched.get("failures") or len(launched.get("tasks", [])) != 1:
        raise RuntimeError("Demo ECS task did not launch")
    task = launched["tasks"][0]
    arn, cluster = task["taskArn"], task["clusterArn"]
    print(f"dev demo task: {arn}", flush=True)
    try:
        subprocess.run(["aws", "ecs", "wait", "tasks-stopped", "--cluster", cluster, "--tasks", arn], check=True)
    except subprocess.CalledProcessError:
        aws("ecs", "stop-task", "--cluster", cluster, "--task", arn, "--reason", "Dev demo CI waiter failed")
        raise RuntimeError("Demo task waiter failed; stop requested") from None
    stopped = aws("ecs", "describe-tasks", "--cluster", cluster, "--tasks", arn)
    tasks = stopped.get("tasks", [])
    containers = tasks[0].get("containers", []) if len(tasks) == 1 else []
    if stopped.get("failures") or not containers or any(item.get("exitCode") != 0 for item in containers):
        raise RuntimeError(f"Demo task failed; inspect {outputs.get('MigrateLogGroup', 'the migration task logs')}")
    print("dev demo seed completed (existing completed scenarios preserved)", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--stack", required=True)
    options = parser.parse_args()
    try:
        run(options.stack)
    except (RuntimeError, KeyError, ValueError, subprocess.CalledProcessError) as error:
        # AWS outputs do not carry secret values; do not echo failed command arguments.
        parser.exit(1, f"dev demo failed: {error if isinstance(error, RuntimeError) else type(error).__name__}\n")
