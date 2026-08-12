GLIBC gconv modules (GB18030/GBK) extracted from aarch64-linux-gnu-glibc-2.27
(LGPL-2.1). The dict pen's rootfs lacks /usr/lib/gconv, so the runner deploys
these to /tmp/gconv and sets GCONV_PATH to decode GB18030 lyrics (kw).
