# frozen_string_literal: true

require "date"
require "open3"
require "optparse"
require "pathname"
require "yaml"

POST_FILENAME = /\A\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*\.md\z/
ASSET_FILENAME = /\A[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+)?\z/
BITMAP_EXTENSIONS = %w[.bmp .gif .jpeg .jpg .png .tif .tiff .webp].freeze
REQUIRED_FRONT_MATTER = %w[title date description categories tags].freeze
DATE_WITH_ZONE = /\A\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})? \+08:00\z/

def parse_options(arguments)
  options = { base: ENV["CONTENT_BASE_REF"] }
  OptionParser.new do |parser|
    parser.banner = "Usage: ruby scripts/validate_content.rb [--base GIT_REF]"
    parser.on("--base GIT_REF", "Compare added and renamed assets with this Git ref") do |base|
      options = options.merge(base: base)
    end
  end.parse!(arguments)
  options
end

def validate_post_filename(path)
  filename = File.basename(path)
  return ["#{path}: filename must match YYYY-MM-DD-lowercase-hyphenated-title.md"] unless filename.match?(POST_FILENAME)

  Date.iso8601(filename[0, 10])
  []
rescue Date::Error
  ["#{path}: filename contains an invalid calendar date"]
end

def parse_asset_diff(fields)
  paths = []
  cursor = 0
  while cursor < fields.length && !fields[cursor].empty?
    status = fields[cursor]
    cursor += 1
    if status.start_with?("A")
      paths = paths + [fields[cursor]]
      cursor += 1
    elsif status.start_with?("R")
      paths = paths + [fields[cursor + 1]]
      cursor += 2
    end
  end
  paths
end

def load_front_matter(path)
  content = File.read(path, encoding: "UTF-8")
  match = content.match(/\A---\s*\r?\n(.*?)\r?\n---\s*(?:\r?\n|\z)/m)
  return [nil, ["#{path}: missing YAML front matter"]] unless match

  data = YAML.safe_load(
    match[1],
    permitted_classes: [Date, DateTime, Time],
    aliases: false
  )
  return [nil, ["#{path}: front matter must be a YAML mapping"]] unless data.is_a?(Hash)

  [data.transform_keys(&:to_s), []]
rescue Psych::Exception => error
  [nil, ["#{path}: invalid YAML front matter (#{error.message.lines.first.strip})"]]
end

def validate_front_matter(path)
  data, errors = load_front_matter(path)
  return errors unless data

  missing = REQUIRED_FRONT_MATTER.reject { |key| data.key?(key) }
  errors += missing.map { |key| "#{path}: missing front matter key '#{key}'" }
  errors += ["#{path}: 'title' must be a non-empty string"] unless data["title"].is_a?(String) && !data["title"].strip.empty?
  errors += ["#{path}: 'date' must include a valid date, time, and UTC offset"] unless valid_post_date?(data["date"])
  valid_description = data["description"].is_a?(String) && !data["description"].strip.empty?
  errors += ["#{path}: 'description' must be a non-empty string"] unless valid_description

  %w[categories tags].each do |key|
    valid_values = data[key].is_a?(Array) && !data[key].empty? &&
                   data[key].all? { |value| value.is_a?(String) && !value.strip.empty? }
    next if valid_values

    errors += ["#{path}: '#{key}' must contain at least one non-empty value"]
  end
  errors
end

def valid_post_date?(value)
  return value.utc_offset == 8 * 60 * 60 if value.is_a?(Time)
  return value.offset == Rational(8, 24) if value.is_a?(DateTime)
  return false unless value.is_a?(String) && value.match?(DATE_WITH_ZONE)

  DateTime.parse(value)
  true
rescue Date::Error
  false
end

def changed_assets(base)
  comparison_base = base || "HEAD^"
  resolved_base = resolve_commit(comparison_base)

  command = [
    "git", "diff", "--name-status", "-z", "--find-renames", "--diff-filter=AR",
    "--end-of-options", "#{resolved_base}...HEAD", "--", "assets"
  ]
  output, error, status = Open3.capture3(*command)
  raise "git diff failed for '#{comparison_base}': #{error.strip}" unless status.success?

  parse_asset_diff(output.split("\0")).compact
end

def resolve_commit(reference)
  raise "Git base reference must not be empty or start with '-'" if reference.empty? || reference.start_with?("-")

  output, error, status = Open3.capture3(
    "git", "rev-parse", "--verify", "--end-of-options", "#{reference}^{commit}"
  )
  raise "invalid Git base reference '#{reference}': #{error.strip}" unless status.success?

  output.strip
end

def validate_asset(path)
  filename = Pathname(path).basename.to_s
  extension = File.extname(filename)
  errors = []
  errors += ["#{path}: asset filename must use lowercase alphanumeric words separated by underscores"] unless filename.match?(ASSET_FILENAME)
  errors += ["#{path}: bitmap assets must use the .jpg extension"] if BITMAP_EXTENSIONS.include?(extension.downcase) && extension != ".jpg"
  errors
end

def tracked_posts
  output, error, status = Open3.capture3("git", "ls-files", "-z", "--", "_posts/*.md")
  raise "git ls-files failed: #{error.strip}" unless status.success?

  output.split("\0").reject(&:empty?).sort.freeze
end

def run(arguments)
  options = parse_options(arguments)
  post_paths = tracked_posts
  errors = post_paths.flat_map do |path|
    validate_post_filename(path) + validate_front_matter(path)
  end
  errors += changed_assets(options[:base]).flat_map { |path| validate_asset(path) }

  if errors.empty?
    puts "Content validation passed (#{post_paths.length} posts checked)."
    return 0
  end

  warn errors.map { |error| "ERROR: #{error}" }.join("\n")
  1
end

exit run(ARGV) if $PROGRAM_NAME == __FILE__
