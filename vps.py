from __future__ import annotations

import fcntl
import os
import pty
import resource
import select
import shutil
import signal
import struct
import termios
import threading
import time
from pathlib import Path
from typing import Optional

CPU_SECONDS = 3600
MAX_PROCESSES = 64
MAX_VIRT_MEMORY = 1024 * 1024 * 1024
MAX_FILE_SIZE = 512 * 1024 * 1024
DISK_QUOTA = 500 * 1024 * 1024
IDLE_TIMEOUT_SEC = 30 * 60


def _have_bwrap() -> bool:
    if os.environ.get("CLOUDVAULT_DISABLE_BWRAP") == "1":
        return False
    return shutil.which("bwrap") is not None


class VPSSession:
    def __init__(self, user_id: int, home_root: Path) -> None:
        self.user_id = user_id
        self.home = (home_root / f"user_{user_id}").resolve()
        self.home.mkdir(parents=True, exist_ok=True)
        self.pid: int | None = None
        self.fd: int | None = None
        self.alive: bool = False
        self.last_activity: float = time.time()
        self._lock = threading.Lock()

    def start(self, cols: int = 80, rows: int = 24) -> None:
        if self.alive:
            return

        username = f"user{self.user_id}"
        env = {
            "HOME": str(self.home),
            "PWD": str(self.home),
            "USER": username,
            "LOGNAME": username,
            "TERM": "xterm-256color",
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "SHELL": "/bin/bash",
            "PS1": r"\[\e[1;32m\]" + username + r"@cloudvault\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ ",
        }

        motd = self.home / ".cloudvault_motd"
        if not motd.exists():
            (self.home / ".bashrc").write_text(
                f'export PS1="\\[\\e[1;32m\\]{username}@cloudvault\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ "\n'
                'alias ll="ls -lah --color=auto"\n'
                'alias ls="ls --color=auto"\n'
                'cat ~/.cloudvault_motd 2>/dev/null\n'
            )
            motd.write_text(
                "\n"
                "  \x1b[1;35mCloudVault Free VPS\x1b[0m  \x1b[2m(real bash on Linux)\x1b[0m\n"
                "  \x1b[2m-----------------------------------------\x1b[0m\n"
                f"  user:   \x1b[36m{username}\x1b[0m\n"
                f"  home:   \x1b[36m~\x1b[0m  (persistent, 500 MB quota)\n"
                "  net:    \x1b[33moffline\x1b[0m  (sandboxed)\n"
                "  tools:  bash, coreutils, python3, git, curl, vim, nano\n\n"
                "  Type \x1b[1mhelp\x1b[0m or just start hacking.\n\n"
            )

        use_bwrap = _have_bwrap()
        for attempt in range(2):
            if self._fork_shell(env, use_bwrap):
                self.set_winsize(rows, cols)
                return
            use_bwrap = False
        self.alive = False
        raise RuntimeError("failed to spawn bash (both bwrap and plain fallback)")

    def _fork_shell(self, env: dict, use_bwrap: bool) -> bool:
        pid, fd = pty.fork()
        if pid == 0:
            try:
                resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
                resource.setrlimit(resource.RLIMIT_AS, (MAX_VIRT_MEMORY, MAX_VIRT_MEMORY))
                resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_SIZE, MAX_FILE_SIZE))
            except Exception:
                pass

            try:
                os.chdir(self.home)
            except OSError:
                pass

            if use_bwrap:
                cmd = [
                    "bwrap",
                    "--ro-bind", "/usr", "/usr",
                    "--ro-bind", "/bin", "/bin",
                    "--ro-bind", "/sbin", "/sbin",
                    "--ro-bind", "/lib", "/lib",
                    "--ro-bind-try", "/lib64", "/lib64",
                    "--ro-bind", "/etc", "/etc",
                    "--bind", str(self.home), str(self.home),
                    "--dev", "/dev",
                    "--proc", "/proc",
                    "--tmpfs", "/tmp",
                    "--unshare-pid",
                    "--unshare-net",
                    "--unshare-uts",
                    "--unshare-ipc",
                    "--hostname", "cloudvault",
                    "--die-with-parent",
                    "--chdir", str(self.home),
                    "/bin/bash",
                ]
            else:
                cmd = ["/bin/bash"]

            try:
                os.execvpe(cmd[0], cmd, env)
            except (FileNotFoundError, Exception):
                os._exit(127)

        self.pid = pid
        self.fd = fd
        time.sleep(0.15)
        try:
            wpid, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            wpid, status = 0, 0
        if wpid != 0:
            try:
                os.close(fd)
            except OSError:
                pass
            self.pid = None
            self.fd = None
            return False
        self.alive = True
        return True

    def set_winsize(self, rows: int, cols: int) -> None:
        if self.fd is None:
            return
        try:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ,
                        struct.pack("HHHH", rows, cols, 0, 0))
        except Exception:
            pass

    def write(self, data: bytes) -> None:
        with self._lock:
            if not self.alive or self.fd is None:
                return
            try:
                os.write(self.fd, data)
                self.last_activity = time.time()
            except OSError:
                self.alive = False

    def read_nonblock(self, max_bytes: int = 4096, timeout: float = 0.05) -> bytes:
        fd = self.fd
        if not self.alive or fd is None or fd < 0:
            return b""
        try:
            r, _, _ = select.select([fd], [], [], timeout)
        except (OSError, ValueError):
            self.alive = False
            return b""
        if not r:
            return b""
        fd = self.fd
        if fd is None or fd < 0:
            return b""
        try:
            chunk = os.read(fd, max_bytes)
            if not chunk:
                self.alive = False
                return b""
            self.last_activity = time.time()
            return chunk
        except OSError:
            self.alive = False
            return b""

    def close(self) -> None:
        with self._lock:
            self.alive = False
            if self.pid:
                try:
                    os.kill(self.pid, signal.SIGTERM)
                except (ProcessLookupError, OSError):
                    pass
            if self.fd is not None:
                try:
                    os.close(self.fd)
                except OSError:
                    pass
            self.fd = None
            if self.pid:
                try:
                    os.waitpid(self.pid, os.WNOHANG)
                except (ChildProcessError, OSError):
                    pass
            self.pid = None


def disk_usage(home: Path) -> int:
    total = 0
    if not home.exists():
        return 0
    for root, _dirs, files in os.walk(home, followlinks=False):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def reset_home(home_root: Path, user_id: int) -> None:
    target = (home_root / f"user_{user_id}").resolve()
    if not target.exists():
        return
    if not str(target).startswith(str(home_root.resolve())):
        return
    shutil.rmtree(target, ignore_errors=True)
