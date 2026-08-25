# dsh vendoring

Pin: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (release dsh-0.1.1-rc.2).

The dsh source is NOT committed here. The image build clones the pin,
verifies the commit hash, installs with a frozen lockfile, builds the
frontend dist, and applies the patch queue from `patches/` (rebasing patch
series - the only sanctioned form of divergence; a hard fork is prohibited).

Re-pin procedure: new pin commit -> rebase patches/ -> re-run the seam
coverage audit -> new measured image version.
