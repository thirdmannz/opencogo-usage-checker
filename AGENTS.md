# AGENTS.md — CRITICAL PROCESS WARNING

## ⛔ DO NOT KILL ocwrapper

The `ocwrapper` Node.js process on port 3333 is a **production background service**
used by multiple projects. It must NEVER be killed, even during cleanup.

### Rules

1. **NEVER** run `taskkill /F /IM node.exe` — this kills ALL node processes including ocwrapper
2. **NEVER** run `killall node` or similar mass-kill commands
3. **NEVER** stop, restart, or modify anything in `C:\Projects\ocwrapper\`
4. If you need to free resources, identify the specific process by PID and kill only that one
5. Check `netstat -ano | findstr :3333` to see the ocwrapper PID — never kill that PID

### If you accidentally killed it

The guardian watchdog will auto-restart it within 5 minutes. You can also manually:
```
wscript.exe C:\Projects\ocwrapper\launch.vbs
```

### Why this matters

ocwrapper provides HTTP API services on port 3333 that other projects depend on.
Killing it causes cascading failures across multiple projects.
