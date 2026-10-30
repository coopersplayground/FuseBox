#!/bin/bash
# Prepare a freshly staged release: build the listener venv if absent.
# The updater runs this after a flip when the new release has no venv;
# install.sh's own venv step makes it a no-op on first install.
set -e
cd "$(dirname "$0")"
if [ ! -x venv/bin/python ]; then
  python3 -m venv venv
  venv/bin/pip install --quiet --upgrade pip
  venv/bin/pip install --quiet -r requirements.txt
fi
