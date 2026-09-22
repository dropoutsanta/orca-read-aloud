#!/bin/sh
set -e
cd "$(dirname "$0")"
swiftc -O -o mic-in-use mic-in-use.swift
swiftc -O -o stop-hotkey stop-hotkey.swift
echo "built mic-in-use and stop-hotkey"
