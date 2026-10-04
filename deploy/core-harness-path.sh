# Installed as /etc/profile.d/actana-harness-path.sh by core.Dockerfile (#559).
#
# The directories Harness CLIs install into under a login user's home, for the
# login shells of the Core image. The daemon does not read this: it builds a
# Session's PATH itself (`coreChildEnv`). A test keeps this list equal to the
# registry's `homePathSuffixes`, last-first: each one is put in front, so
# `~/.local/bin` ends up leading, as it does on a Session's PATH. POSIX sh only,
# because /etc/profile sources it from bash and dash alike.
for actana_dir in "$HOME/.opencode/bin" "$HOME/.local/bin"; do
  case ":$PATH:" in
    *":$actana_dir:"*) ;;
    *) PATH="$actana_dir:$PATH" ;;
  esac
done
unset actana_dir
export PATH
