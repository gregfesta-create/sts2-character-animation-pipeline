extends RefCounted
# Lossless self-contained storage, without editor import caches or lossy settings.
# Keep the compressed buffer so a loaded scene can be saved into another package.
static func from_image(image: Image) -> PortableCompressedTexture2D:
	if image==null or image.is_empty() or image.get_width()>4096 or image.get_height()>4096: return null
	var texture=PortableCompressedTexture2D.new()
	texture.keep_compressed_buffer=true
	texture.create_from_image(image,PortableCompressedTexture2D.COMPRESSION_MODE_LOSSLESS)
	return texture
