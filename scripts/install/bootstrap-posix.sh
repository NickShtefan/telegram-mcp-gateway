#!/bin/sh
# Trusted/reviewed bootstrap verification, not a self-authenticating download.
# Production elevation/acquisition requires the independent owner trust gate.
set -eu
PATH=/usr/bin:/bin
export PATH
LC_ALL=C
export LC_ALL
unset NODE_OPTIONS NODE_PATH ENV BASH_ENV CDPATH
fail() { printf '%s\n' '{"format_version":1,"error_code":"bootstrap_verification_failed"}' >&2; exit 1; }
trusted_signer_sha256='f6d3d70c8909d302f24c6853dfb82dad1ab7a2a2006221699002117b6a22c682'
readonly trusted_signer_sha256
pin=$trusted_signer_sha256
case "$#" in
  2) bundle=$1; source_sha=; operation=$2 ;;
  3) bundle=$1; source_sha=$2; operation=$3 ;;
  4) bundle=$1; [ "$2" = "$trusted_signer_sha256" ] || fail; source_sha=$3; operation=$4 ;;
  *) fail ;;
esac
# A directory is a maintainer bundle and needs the exact source. Anything else is
# a release archive; its optional source argument pins one exact signed build.
if [ -d "$bundle" ]; then archive_input=0; else archive_input=1; fi
[ "$operation" = verify ] || [ "$operation" = prepare ] || [ "$operation" = install ] || fail
if [ "$operation" = install ]; then [ "$(/usr/bin/id -u)" -eq 0 ] || fail; fi
[ "${#pin}" -eq 64 ] || fail
{ [ "$archive_input" -eq 1 ] && [ -z "$source_sha" ]; } || [ "${#source_sha}" -eq 40 ] || fail
if [ "$archive_input" -eq 1 ] && [ ! -f "$bundle" ]; then
  # Typical after a browser expanded or renamed the download: name the cause.
  printf '%s\n' '{"format_version":1,"error_code":"bootstrap_archive_missing"}' >&2; exit 1
fi
case "$pin$source_sha" in *[!0-9a-f]*) fail ;; esac
case "$(/usr/bin/uname -s)" in
  Darwin) target=darwin; base=/private/tmp; stat_size() { /usr/bin/stat -f %z "$1"; }; stat_links() { /usr/bin/stat -f %l "$1"; } ;;
  Linux) target=linux; base=/tmp; stat_size() { /usr/bin/stat -c %s "$1"; }; stat_links() { /usr/bin/stat -c %h "$1"; } ;;
  *) fail ;;
esac
case "$(/usr/bin/uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) fail ;; esac
linux_prerequisites() {
  os_id=$(/usr/bin/awk -F= '$1=="ID" {gsub(/"/,"",$2);print $2}' /etc/os-release)
  os_version=$(/usr/bin/awk -F= '$1=="VERSION_ID" {gsub(/"/,"",$2);print $2}' /etc/os-release)
  case "$os_id:$os_version:$arch" in ubuntu:24.04:arm64|ubuntu:24.04:x64) manager=ubuntu ;; arch:*:x64) manager=arch ;; *) fail ;; esac
  missing=
  [ -x /usr/bin/openssl ] || missing="$missing openssl"
  [ -x /usr/bin/perl ] || missing="$missing perl"
  [ -x /usr/bin/gzip ] || missing="$missing gzip"
  [ -x /usr/bin/getfacl ] || missing="$missing acl"
  [ -x /usr/bin/flock ] || missing="$missing util-linux"
  [ -x /usr/bin/systemctl ] || missing="$missing systemd"
  if [ ! -x /usr/sbin/useradd ]; then
    if [ "$manager" = ubuntu ]; then missing="$missing passwd"; else missing="$missing shadow"; fi
  fi
  [ -n "$missing" ] || return 0
  printf 'Missing official OS prerequisites:%s\n' "$missing" >&2
  [ "$operation" = install ] && [ "$(/usr/bin/id -u)" -eq 0 ] && [ -t 0 ] && [ -t 2 ] || fail
  # Isolate package resolution from all configured third-party repositories,
  # apt hooks/options and pacman Include directives. No global index refresh.
  package_stage=$(/usr/bin/mktemp -d /tmp/tg-mcp-prerequisites.XXXXXX) || fail
  trap '/bin/rm -rf "$package_stage"' EXIT HUP INT TERM
  /bin/chmod 700 "$package_stage"
  if [ "$manager" = ubuntu ]; then
    [ -x /usr/bin/apt-get ] && [ -f /usr/share/keyrings/ubuntu-archive-keyring.gpg ] || fail
    /bin/mkdir "$package_stage/lists" "$package_stage/lists/partial" "$package_stage/archives" "$package_stage/archives/partial"
    if [ "$arch" = arm64 ]; then mirror=https://ports.ubuntu.com/ubuntu-ports; security=$mirror
    else mirror=https://archive.ubuntu.com/ubuntu; security=https://security.ubuntu.com/ubuntu; fi
    /bin/cat >"$package_stage/sources.list" <<EOF
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $mirror noble main universe
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $mirror noble-updates main universe
deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] $security noble-security main universe
EOF
    /bin/cat >"$package_stage/apt.conf" <<EOF
Dir::Etc::main "/dev/null";
Dir::Etc::parts "$package_stage/absent";
Dir::Etc::sourcelist "$package_stage/sources.list";
Dir::Etc::sourceparts "$package_stage/absent";
Dir::State::lists "$package_stage/lists";
Dir::Cache::archives "$package_stage/archives";
Dir::Cache::pkgcache "";
Dir::Cache::srcpkgcache "";
Dir::Etc::preferences "/dev/null";
Dir::Etc::preferencesparts "$package_stage/absent";
APT::Sandbox::User "root";
Acquire::AllowInsecureRepositories "false";
APT::Get::AllowUnauthenticated "false";
EOF
    apt_official() { /usr/bin/env -i PATH=/usr/bin:/bin APT_CONFIG="$package_stage/apt.conf" /usr/bin/apt-get "$@"; }
    # Refresh only this disposable official-source index, never host sources.
    apt_official update >&2 || fail
    apt_official --simulate --no-upgrade --no-install-recommends install $missing >&2 || fail
  else
    [ -x /usr/bin/pacman ] || fail
    /bin/mkdir "$package_stage/cache"
    /bin/cat >"$package_stage/pacman.conf" <<EOF
[options]
Architecture = x86_64
CacheDir = $package_stage/cache
DownloadUser = root
SigLevel = Required DatabaseOptional
LocalFileSigLevel = Required
[core]
Server = https://geo.mirror.pkgbuild.com/core/os/x86_64
[extra]
Server = https://geo.mirror.pkgbuild.com/extra/os/x86_64
EOF
    /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/pacman --config "$package_stage/pacman.conf" -Sp --needed --print-format '%n %v %r %l' $missing >&2 || fail
  fi
  printf 'Type INSTALL to approve only this official-source prerequisite transaction, or cancel: ' >/dev/tty
  IFS= read -r consent </dev/tty || fail
  [ "$consent" = INSTALL ] || fail
  if [ "$manager" = ubuntu ]; then
    apt_official --no-upgrade --no-install-recommends install $missing >&2 || fail
  else
    /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/pacman --config "$package_stage/pacman.conf" -S --needed $missing >&2 || fail
  fi
  /bin/rm -rf "$package_stage"
  trap - EXIT HUP INT TERM
  [ -x /usr/bin/openssl ] && [ -x /usr/bin/perl ] && [ -x /usr/bin/getfacl ] && [ -x /usr/bin/flock ] && [ -x /usr/bin/systemctl ] && [ -x /usr/sbin/useradd ] || fail
}
if [ "$target" = linux ]; then linux_prerequisites; fi
[ -x /usr/bin/openssl ] && [ -x /usr/bin/perl ] || fail
regular() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat_links "$1")" -eq 1 ]; }
openssl_clean() { /usr/bin/env -i PATH=/usr/bin:/bin OPENSSL_CONF=/dev/null /usr/bin/openssl "$@"; }
stage=$(/usr/bin/mktemp -d "$base/tg-mcp-candidate.XXXXXX") || fail
keep=0
snapshot() {
  /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/perl -e '
    use strict; use Fcntl qw(:DEFAULT :mode);
    $SIG{ALRM}=sub{die}; alarm 15;
    my($source,$target,$maximum)=@ARGV;
    die unless defined($maximum) && $maximum =~ /^[1-9][0-9]{0,8}$/;
    sysopen(my $input,$source,O_RDONLY|O_NOFOLLOW|O_NONBLOCK) or die;
    my @state=stat($input); die unless @state && S_ISREG($state[2]) && $state[3]==1 && $state[7]<=$maximum;
    sysopen(my $output,$target,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600) or die;
    my $total=0;
    while(1){my $count=sysread($input,my $data,65536);die unless defined($count);last if $count==0;$total+=$count;die if $total>$maximum;
      my $offset=0;while($offset<$count){my $written=syswrite($output,$data,$count-$offset,$offset);die unless defined($written)&&$written>0;$offset+=$written;}}
    close($input) or die;close($output) or die;alarm 0;
  ' "$1" "$2" "$3" 2>/dev/null || fail
}
trap '[ "$keep" -eq 1 ] || /bin/rm -rf "$stage"' EXIT HUP INT TERM
if [ "$archive_input" -eq 1 ]; then
  [ -x /usr/bin/gzip ] || fail
  snapshot "$bundle" "$stage/download.tar.gz" 134217728
  /bin/mkdir -m 700 "$stage/transport"
  /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/perl -e '
    use strict; use Fcntl qw(:DEFAULT);
    $SIG{ALRM}=sub{die}; alarm 120;
    my($archive,$target)=@ARGV;open(my $in,"-|","/usr/bin/gzip","-dc",$archive) or die;
    my %limits=("manifest.tsv"=>8192,"manifest.sig"=>384,"signer.der"=>16384,"node"=>134217728,"installer.mjs"=>1048576,"manifest.mjs"=>1048576,"archive.mjs"=>1048576,"application.tar.gz"=>134217728,"NODE_LICENSE"=>1048576);my %seen;my $total=0;
    sub exact {my($fh,$n)=@_;my $out="";while(length($out)<$n){my $got=read($fh,my $piece,$n-length($out));die unless defined($got)&&$got>0;$out.=$piece;}return $out;}
    sub octal {my($h,$at,$n)=@_;my $v=substr($h,$at,$n);$v=~s/\0.*$//s;die unless $v=~/^[0-7]+$/;return oct($v);}
    while(1){my $h=exact($in,512);if($h eq "\0"x512){die unless exact($in,512) eq "\0"x512;my $tail;while(read($in,$tail,65536)){die if $tail=~/[^\0]/;$total+=length($tail);die if $total>300000000;}last;}
      my $name=substr($h,0,100);$name=~s/\0.*$//s;die unless exists($limits{$name})&&!$seen{$name}++;my $size=octal($h,124,12);die unless $size>0&&$size<=$limits{$name};$total+=512+$size;die if $total>300000000;
      my $sum=0;for my $i(0..511){$sum+=($i>=148&&$i<156)?32:ord(substr($h,$i,1));}die unless $sum==octal($h,148,8)&&substr($h,156,1) eq "0"&&substr($h,157,100) eq "\0"x100&&substr($h,257,6) eq "ustar\0"&&substr($h,263,2) eq "00"&&substr($h,345,167) eq "\0"x167;
      sysopen(my $file,"$target/$name",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600) or die;my $left=$size;while($left){my $n=$left>65536?65536:$left;my $data=exact($in,$n);my $at=0;while($at<$n){my $w=syswrite($file,$data,$n-$at,$at);die unless defined($w)&&$w>0;$at+=$w;}$left-=$n;}close($file) or die;my $padding=(512-$size%512)%512;die if $padding&&exact($in,$padding) ne "\0"x$padding;
    }
    die unless keys(%seen)==9;close($in) or die;alarm 0;
  ' "$stage/download.tar.gz" "$stage/transport" 2>/dev/null || fail
  bundle=$stage/transport
fi
for name in manifest.tsv manifest.sig signer.der; do regular "$bundle/$name" || fail; done
[ "$(stat_size "$bundle/manifest.tsv")" -le 8192 ] && [ "$(stat_size "$bundle/manifest.sig")" -eq 384 ] && [ "$(stat_size "$bundle/signer.der")" -le 16384 ] || fail
# Work on private snapshots; source substitution is rechecked on copied bytes.
snapshot "$bundle/manifest.tsv" "$stage/manifest.tsv" 8192
snapshot "$bundle/manifest.sig" "$stage/manifest.sig" 384
snapshot "$bundle/signer.der" "$stage/signer.der" 16384
[ "$(stat_size "$stage/manifest.sig")" -eq 384 ] || fail
[ "$(openssl_clean dgst -sha256 "$stage/signer.der" 2>/dev/null | /usr/bin/awk '{print $NF}')" = "$pin" ] || fail
openssl_clean x509 -inform DER -in "$stage/signer.der" -pubkey -noout > "$stage/public.pem" 2>/dev/null || fail
case "$(openssl_clean rsa -pubin -in "$stage/public.pem" -text -noout 2>/dev/null)" in *'(3072 bit)'*) ;; *) fail ;; esac
openssl_clean dgst -sha256 -verify "$stage/public.pem" -signature "$stage/manifest.sig" "$stage/manifest.tsv" >/dev/null 2>&1 || fail
if [ -z "$source_sha" ]; then
  source_sha=$(/usr/bin/awk -F '\t' 'NR==3&&$1=="source_sha" {print $2}' "$stage/manifest.tsv")
  [ "${#source_sha}" -eq 40 ] || fail
  case "$source_sha" in *[!0-9a-f]*) fail ;; esac
fi
# Closed wire grammar and fixed role filenames; no manifest field is executed.
/usr/bin/awk -F '\t' -v source="$source_sha" -v target="$target" -v arch="$arch" '
function bad() { exit 1 }
NR==1 { if($0!="TG_MCP_RELEASE_V1") bad(); next }
NR==2 { if(NF!=2 || $1!="version" || $2!="0.2.0") bad(); next }
NR==3 { if(NF!=2 || $1!="source_sha" || $2!=source) bad(); next }
NR==4 { if(NF!=2 || $1!="platform" || $2!=target) bad(); next }
NR==5 { if(NF!=2 || $1!="architecture" || $2!=arch) bad(); next }
NR==6 { if(NF!=2 || $1!="node_version" || $2!~/^[0-9]+\.[0-9]+\.[0-9]+$/) bad(); split($2,v,"."); if(!((v[1]==22 && v[2]>=13)||v[1]==24))bad(); next }
NR>=7 && NR<=12 {
  split("node installer manifest_helper archive_helper application node_license",roles," "); split("node installer.mjs manifest.mjs archive.mjs application.tar.gz NODE_LICENSE",names," ");
  i=NR-6; max=(i==1 || i==5)?134217728:1048576;
  if(NF!=5 || $1!="file" || $2!=roles[i] || $3!=names[i] || $4!~/^[1-9][0-9]*$/ || length($4)>9 || $4>max || length($5)!=64 || $5~/[^0-9a-f]/)bad(); next }
{ bad() }
END { if(NR!=12)exit 1 }
' "$stage/manifest.tsv" || fail
node_version=$(/usr/bin/awk -F '\t' '$1=="node_version" {print $2}' "$stage/manifest.tsv")
if [ "$target" = darwin ]; then
  os_version=$(/usr/bin/sw_vers -productVersion) || fail
  /usr/bin/awk -v os="$os_version" -v runtime="$node_version" 'BEGIN {split(os,o,".");split(runtime,n,".");if(o[1]<13 || (n[1]==24 && o[1]==13 && o[2]<5))exit 1}' || fail
fi
for name in node installer.mjs manifest.mjs archive.mjs application.tar.gz NODE_LICENSE; do
  regular "$bundle/$name" || fail
  expected_size=$(/usr/bin/awk -F '\t' -v n="$name" '$1=="file" && $3==n {print $4}' "$stage/manifest.tsv")
  expected_sha=$(/usr/bin/awk -F '\t' -v n="$name" '$1=="file" && $3==n {print $5}' "$stage/manifest.tsv")
  [ "$(stat_size "$bundle/$name")" -eq "$expected_size" ] || fail
  snapshot "$bundle/$name" "$stage/$name" "$expected_size"
  /bin/chmod 600 "$stage/$name"
  [ "$(stat_size "$stage/$name")" -eq "$expected_size" ] || fail
  [ "$(openssl_clean dgst -sha256 "$stage/$name" 2>/dev/null | /usr/bin/awk '{print $NF}')" = "$expected_sha" ] || fail
done
/bin/chmod 700 "$stage/node"
# Node/npm in the caller's environment are never used.
if [ "$operation" = verify ]; then
  /usr/bin/env -i PATH=/usr/bin:/bin "$stage/node" "$stage/installer.mjs" --version 0.2.0 --source-sha "$source_sha" --signer-sha256 "$pin" || fail
else
  /usr/bin/env -i PATH=/usr/bin:/bin "$stage/node" "$stage/installer.mjs" --version 0.2.0 --source-sha "$source_sha" --signer-sha256 "$pin" --extract || fail
  if [ "$operation" = install ]; then
    # This script must already be independently trusted before sudo. The staging
    # directory is now administrator-owned; unprivileged agents cannot alter it.
    /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin "$stage/node" "$stage/application/dist/install/provisionCli.js" --source-sha "$source_sha" --signer-sha256 "$pin" || fail
    if [ "$target" = darwin ]; then owner_command="/Library/Application Support/TelegramMCPGateway/bin/tg-mcp-owner"; else owner_command=/opt/telegram-mcp-gateway/bin/tg-mcp-owner; fi
    printf 'Installation prepared. In your ordinary terminal run: "%s" setup\n' "$owner_command" >&2
  else
    keep=1
  fi
  if [ "$operation" = prepare ]; then
    printf '{"format_version":1,"phase":"candidate_staged","candidate":"%s","installed":false}\n' "$stage"
  fi
fi
