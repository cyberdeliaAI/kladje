"""Sample the test executable and WebKit services macOS attributes to it."""
import ctypes
import json
import os
import subprocess
import sys

owner = ctypes.CDLL(None).responsibility_get_pid_responsible_for_pid
rows = [line.strip().split(None, 2) for line in subprocess.check_output(
    ["ps", "-axo", "pid=,rss=,comm="], text=True).splitlines() if line.strip()]
host = next((int(pid) for pid, _, executable in rows if executable == os.path.realpath(sys.argv[1])), None)
sizes = {}
for pid, rss, executable in rows:
    if int(pid) == host:
        sizes["host"] = int(rss)
    elif "com.apple.WebKit." in executable and owner(int(pid)) == host:
        name = executable.rsplit("/", 1)[-1]
        sizes[name] = sizes.get(name, 0) + int(rss)
print(json.dumps({"pid": host, "sizes": sizes}))
