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

  build() {
    if (this.name === ResourceIconName.FILES) {
      Image($r('app.media.af_files'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else if (this.name === ResourceIconName.AI) {
      Image($r('app.media.af_ai'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else if (this.name === ResourceIconName.VERSIONS) {
      Image($r('app.media.af_versions'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else if (this.name === ResourceIconName.REFRESH) {
      Image($r('app.media.af_refresh'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else if (this.name === ResourceIconName.PLUS) {
      Image($r('app.media.af_plus'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else if (this.name === ResourceIconName.CROSS) {
      Image($r('app.media.af_cross'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else if (this.name === ResourceIconName.CODE) {
      Image($r('app.media.af_code'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else if (this.name === ResourceIconName.MENU) {
      Image($r('app.media.af_menu'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else if (this.name === ResourceIconName.QUERY) {
      Image($r('app.media.af_query'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else if (this.name === ResourceIconName.SOURCE) {
      Image($r('app.media.af_source'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    } else {
      Image($r('app.media.af_document'))
        .width(this.iconSize).height(this.iconSize).objectFit(ImageFit.Contain);
    }
  }
}
