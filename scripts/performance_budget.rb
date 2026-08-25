# frozen_string_literal: true

SITE = ARGV.fetch(0, "_site")
MAX_CSS_JS_BYTES = 787_200
MAX_EXTERNAL_URLS = 296
MAX_IMAGES_WITHOUT_DIMENSIONS = 186

css_js_bytes = Dir[File.join(SITE, "assets", "**", "*")].select { |path| path.match?(/\.(?:css|js)\z/) }.sum { |path| File.size(path) }
html_files = Dir[File.join(SITE, "**", "*.html")]
html = html_files.map { |path| File.read(path) }
external_urls = html.flat_map { |body| body.scan(/(?:src|href)=["'](https?:\/\/[^"']+)/i).flatten }.uniq
images_without_dimensions = html.sum { |body| body.scan(/<img\b(?![^>]*\b(?:width|height)=)[^>]*>/i).length }

checks = {
  "CSS/JS bytes" => [css_js_bytes, MAX_CSS_JS_BYTES],
  "unique external URLs" => [external_urls.length, MAX_EXTERNAL_URLS],
  "images without dimensions" => [images_without_dimensions, MAX_IMAGES_WITHOUT_DIMENSIONS]
}

checks.each { |label, (actual, maximum)| puts "#{label}: #{actual}/#{maximum}" }
failures = checks.select { |_label, (actual, maximum)| actual > maximum }
abort "Performance budget exceeded: #{failures.keys.join(', ')}" unless failures.empty?
