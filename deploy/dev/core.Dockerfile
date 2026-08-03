# A dev Core-in-a-box: the systemd Ubuntu the installer e2es use
# (scripts/lib/systemd-container.mjs), with the Harness tarball baked in and a
# first-boot unit that installs it as the operator. Build via
# docker-compose.yml, which supplies the `tarball` context.
#
# Where this deliberately diverges from the e2e fixture: that image purges
# sudo to prove the installer never needs it; this one is a machine you do
# dev work ON, so it ships a working toolchain (git, curl, build tools,
# Node 24 for agent CLIs) and gives the operator passwordless sudo.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

# polkitd is what lets the operator enable lingering for their own account
# without being root.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv systemd-container dbus libpam-systemd polkitd \
      sudo ca-certificates curl wget gnupg git openssh-client \
      build-essential python3 unzip zip jq ripgrep less vim-tiny \
 && rm -rf /var/lib/apt/lists/*

# Node 24 (NodeSource) — what the agent CLIs (claude, opencode, …) run on.
# The Harness itself needs none of this; its tarball bundles its own Node.
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# --gid users: Ubuntu already ships a group called `operator`, and useradd
# refuses to create a same-named group over it.
RUN useradd --create-home --shell /bin/bash --gid users operator \
 && echo "operator ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/operator \
 && chmod 0440 /etc/sudoers.d/operator

# Linger baked into the image, not left to `actana setup`: logind stores it in
# /var/lib/systemd/linger — container filesystem, not the core-home volume —
# so an image rebuild would otherwise silently lose it and the daemon would
# only run while someone is shelled in.
RUN mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/operator

COPY --from=tarball . /opt/harness/
COPY core-provision.sh /usr/local/lib/core-provision.sh
COPY core-provision.service /etc/systemd/system/core-provision.service
RUN chmod +x /usr/local/lib/core-provision.sh \
 && systemctl enable core-provision.service

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
