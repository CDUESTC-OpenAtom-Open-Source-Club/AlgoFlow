export enum ResourceIconName {
  FILES = 'files',
  DOCUMENT = 'document',
  AI = 'ai',
  VERSIONS = 'versions',
  REFRESH = 'refresh',
  PLUS = 'plus',
  CROSS = 'cross',
  CODE = 'code',
  MENU = 'menu',
  QUERY = 'query',
  SOURCE = 'source'
}

@Component
export struct ResourceIcon {
  @Prop name: ResourceIconName = ResourceIconName.DOCUMENT;
  @Prop iconSize: number = 18;
  // 为空时使用图标原始白色填充；非空时通过 fillColor 将白色图标染成指定颜色，
  // 从而在浅色背景上也能呈现彩色图标，复用同一套 Game Icon Pack 资源。
  @Prop tint: string = '';

  private resource(): Resource {
    if (this.name === ResourceIconName.FILES) {
      return $r('app.media.af_files');
    } else if (this.name === ResourceIconName.AI) {
      return $r('app.media.af_ai');
    } else if (this.name === ResourceIconName.VERSIONS) {
      return $r('app.media.af_versions');
    } else if (this.name === ResourceIconName.REFRESH) {
      return $r('app.media.af_refresh');
    } else if (this.name === ResourceIconName.PLUS) {
      return $r('app.media.af_plus');
    } else if (this.name === ResourceIconName.CROSS) {
      return $r('app.media.af_cross');
    } else if (this.name === ResourceIconName.CODE) {
      return $r('app.media.af_code');
    } else if (this.name === ResourceIconName.MENU) {
      return $r('app.media.af_menu');
    } else if (this.name === ResourceIconName.QUERY) {
      return $r('app.media.af_query');
    } else if (this.name === ResourceIconName.SOURCE) {
      return $r('app.media.af_source');
    }
    return $r('app.media.af_document');
  }

  build() {
    if (this.tint.length > 0) {
      Image(this.resource())
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain)
        .fillColor(this.tint);
    } else {
      Image(this.resource())
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    }
  }
}
