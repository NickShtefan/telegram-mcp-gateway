/* Retain a BSD flock on inherited descriptor 3. Closing this process must not unlock it. */
#include <sys/file.h>
#include <sys/stat.h>
#include <errno.h>
#include <unistd.h>
int main(void) {
    struct stat state;
    if (fstat(3, &state) != 0 || !S_ISREG(state.st_mode) || state.st_nlink != 1) return 74;
    if (flock(3, LOCK_EX | LOCK_NB) == 0) return 0;
    return errno == EWOULDBLOCK || errno == EAGAIN ? 75 : 74;
}
