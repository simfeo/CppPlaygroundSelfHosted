/*
 * POSIX bits LLVM's Unix support code needs but wasi-libc does not provide.
 *
 * Force-included into every translation unit of the LLVM cross-build
 * (-include wasi_posix_shim.h). Everything here is either a type/constant so
 * the code compiles, or a stub that fails with ENOSYS at runtime - LLVM already
 * handles those calls failing (it is the same path as a sandboxed host).
 */
#ifndef WASI_POSIX_SHIM_H
#define WASI_POSIX_SHIM_H

#ifdef __wasi__

#include <errno.h>
#include <stddef.h>
#include <sys/resource.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ---- resource limits (Process.inc, Program.inc, ProgramStack.cpp) ---- */
#ifndef RLIMIT_CORE
#define RLIMIT_CPU 0
#define RLIMIT_FSIZE 1
#define RLIMIT_DATA 2
#define RLIMIT_STACK 3
#define RLIMIT_CORE 4
#define RLIMIT_NOFILE 7
#define RLIMIT_AS 9
#define RLIM_INFINITY (~0ULL)
typedef unsigned long long rlim_t;
struct rlimit {
    rlim_t rlim_cur;
    rlim_t rlim_max;
};
int getrlimit(int resource, struct rlimit *rlim);
int setrlimit(int resource, const struct rlimit *rlim);
#endif

/* ---- signals (wasi-emulated-signal only covers raise/signal) ---- */
#ifndef SIG_SETMASK
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif

#ifndef WASI_SHIM_HAS_SIGSET
#define WASI_SHIM_HAS_SIGSET
typedef unsigned long sigset_t_shim;
#define sigset_t sigset_t_shim

typedef struct {
    int si_signo;
    int si_code;
    int si_errno;
    void *si_addr;
    pid_t si_pid;
    uid_t si_uid;
    int si_status;
} siginfo_t;

struct sigaction {
    union {
        void (*sa_handler)(int);
        void (*sa_sigaction)(int, siginfo_t *, void *);
    };
    sigset_t sa_mask;
    int sa_flags;
};

#define SA_SIGINFO 4
#define SA_ONSTACK 8
#define SA_RESTART 0x10000
#define SA_NODEFER 0x40000000
#define SA_RESETHAND 0x80000000
#define SA_NOCLDSTOP 1
#define SA_NOCLDWAIT 2

int sigaction(int sig, const struct sigaction *act, struct sigaction *old);
int sigemptyset(sigset_t *set);
int sigfillset(sigset_t *set);
int sigaddset(sigset_t *set, int sig);
int sigdelset(sigset_t *set, int sig);
int sigismember(const sigset_t *set, int sig);
int sigprocmask(int how, const sigset_t *set, sigset_t *old);
unsigned alarm(unsigned seconds);
int kill(pid_t pid, int sig);
#endif

/* ---- terminal size (Process.inc) ---- */
#ifndef TIOCGWINSZ
#define TIOCGWINSZ 0x5413
struct winsize {
    unsigned short ws_row;
    unsigned short ws_col;
    unsigned short ws_xpixel;
    unsigned short ws_ypixel;
};
int ioctl(int fd, int request, ...);
#endif

/* ---- process control: no processes on wasi, so these always fail ---- */
#ifndef WASI_SHIM_HAS_PROCESS
#define WASI_SHIM_HAS_PROCESS
int dup2(int oldfd, int newfd);
int dup(int fd);
pid_t fork(void);
pid_t setsid(void);
int execve(const char *path, char *const argv[], char *const envp[]);
int execv(const char *path, char *const argv[]);
int execvp(const char *file, char *const argv[]);
pid_t wait(int *status);
pid_t waitpid(pid_t pid, int *status, int options);
pid_t wait4(pid_t pid, int *status, int options, void *rusage);
int pipe(int fds[2]);
#endif

/* ---- filesystem odds and ends (Path.inc) ---- */
#ifndef WASI_SHIM_HAS_FS
#define WASI_SHIM_HAS_FS
/* is_local(): nothing is "local" storage under wasi. */
#ifndef MNT_LOCAL
#define MNT_LOCAL 0
#endif

/* fcntl-based file locking: wasi-libc declares struct flock but none of the
 * lock commands, and fcntl() rejects them at runtime. */
#ifndef F_RDLCK
#define F_RDLCK 0
#define F_WRLCK 1
#define F_UNLCK 2
#define F_GETLK 5
#define F_SETLK 6
#define F_SETLKW 7
#endif

/* madvise is advisory only; wasi-libc's emulated mman omits it. */
int posix_madvise(void *addr, size_t len, int advice);

mode_t umask(mode_t mask);
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
int fchown(int fd, uid_t owner, gid_t group);
int chown(const char *path, uid_t owner, gid_t group);

/* dladdr (Path.inc, Signals.inc): no dynamic loading, so it always fails. */
typedef struct {
    const char *dli_fname;
    void *dli_fbase;
    const char *dli_sname;
    void *dli_saddr;
} Dl_info;
int dladdr(const void *addr, Dl_info *info);
#endif

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* __wasi__ */
#endif /* WASI_POSIX_SHIM_H */
