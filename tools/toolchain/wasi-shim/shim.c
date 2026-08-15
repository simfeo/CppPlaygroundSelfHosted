/*
 * Stub definitions for the POSIX calls declared in wasi_posix_shim.h.
 *
 * wasm has no processes, signals or sockets. LLVM only reaches these paths when
 * it tries to fork a subprocess, install a crash handler, or open a socket -
 * all of which the playground avoids - so failing with ENOSYS is both honest
 * and sufficient.
 */
#include "wasi_posix_shim.h"

#ifdef __wasi__

#include <errno.h>
#include <pwd.h>

static int fail(void) {
    errno = ENOSYS;
    return -1;
}

int getrlimit(int resource, struct rlimit *rlim) {
    (void)resource;
    if (rlim) {
        rlim->rlim_cur = RLIM_INFINITY;
        rlim->rlim_max = RLIM_INFINITY;
    }
    return 0;
}

int setrlimit(int resource, const struct rlimit *rlim) {
    (void)resource;
    (void)rlim;
    return 0;
}

int sigaction(int sig, const struct sigaction *act, struct sigaction *old) {
    (void)sig; (void)act; (void)old;
    return 0;
}

int sigemptyset(sigset_t *set) { if (set) *set = 0; return 0; }
int sigfillset(sigset_t *set) { if (set) *set = ~0UL; return 0; }
int sigaddset(sigset_t *set, int sig) { if (set) *set |= (1UL << (sig & 31)); return 0; }
int sigdelset(sigset_t *set, int sig) { if (set) *set &= ~(1UL << (sig & 31)); return 0; }
int sigismember(const sigset_t *set, int sig) { return set ? (*set >> (sig & 31)) & 1 : 0; }
int sigprocmask(int how, const sigset_t *set, sigset_t *old) {
    (void)how; (void)set;
    if (old) *old = 0;
    return 0;
}

unsigned alarm(unsigned seconds) { (void)seconds; return 0; }
int kill(pid_t pid, int sig) { (void)pid; (void)sig; return fail(); }

int ioctl(int fd, int request, ...) { (void)fd; (void)request; return fail(); }

int dup2(int oldfd, int newfd) { (void)oldfd; (void)newfd; return fail(); }
int dup(int fd) { (void)fd; return fail(); }
pid_t fork(void) { return (pid_t)fail(); }
pid_t setsid(void) { return (pid_t)fail(); }
int execve(const char *path, char *const argv[], char *const envp[]) {
    (void)path; (void)argv; (void)envp;
    return fail();
}
int execv(const char *path, char *const argv[]) { (void)path; (void)argv; return fail(); }
int execvp(const char *file, char *const argv[]) { (void)file; (void)argv; return fail(); }
pid_t wait(int *status) { (void)status; return (pid_t)fail(); }
pid_t waitpid(pid_t pid, int *status, int options) {
    (void)pid; (void)status; (void)options;
    return (pid_t)fail();
}
pid_t wait4(pid_t pid, int *status, int options, void *rusage) {
    (void)pid; (void)status; (void)options; (void)rusage;
    return (pid_t)fail();
}
int pipe(int fds[2]) { (void)fds; return fail(); }

int posix_madvise(void *addr, size_t len, int advice) {
    (void)addr; (void)len; (void)advice;
    return 0; /* advice can always be ignored */
}

mode_t umask(mode_t mask) { (void)mask; return 0022; }
uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void) { return 0; }
int fchown(int fd, uid_t owner, gid_t group) { (void)fd; (void)owner; (void)group; return fail(); }
int chown(const char *path, uid_t owner, gid_t group) {
    (void)path; (void)owner; (void)group;
    return fail();
}

int dladdr(const void *addr, Dl_info *info) { (void)addr; (void)info; return 0; }

struct passwd *getpwuid(uid_t uid) { (void)uid; errno = ENOSYS; return 0; }
struct passwd *getpwnam(const char *name) { (void)name; errno = ENOSYS; return 0; }
int getpwuid_r(uid_t uid, struct passwd *pwd, char *buf, size_t buflen,
               struct passwd **result) {
    (void)uid; (void)pwd; (void)buf; (void)buflen;
    if (result) *result = 0;
    return ENOSYS;
}
int getpwnam_r(const char *name, struct passwd *pwd, char *buf, size_t buflen,
               struct passwd **result) {
    (void)name; (void)pwd; (void)buf; (void)buflen;
    if (result) *result = 0;
    return ENOSYS;
}

#endif /* __wasi__ */
