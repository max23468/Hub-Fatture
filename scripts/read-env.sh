#!/bin/sh

env_value() {
  awk -F= -v name="$2" '$1 == name { sub(/^[^=]*=/, ""); print; exit }' "$1"
}
